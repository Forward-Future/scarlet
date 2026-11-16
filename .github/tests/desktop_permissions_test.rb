require "minitest/autorun"
require "yaml"

class DesktopPermissionsTest < Minitest::Test
  MAIN_PUSH = "github.event_name == 'push' && github.ref == 'refs/heads/main'"
  STABLE_RELEASE = "#{MAIN_PUSH} && (needs.version.outputs.signing == 'true' || needs.version.outputs.signing == 'updater-signed')"

  def setup
    workflows = File.expand_path("../workflows", __dir__)
    @entry = YAML.safe_load(File.read(File.join(workflows, "desktop.yml")))
    @jobs = @entry.fetch("jobs")
    @build = YAML.safe_load(File.read(File.join(workflows, "desktop-build.yml"))).fetch("jobs").fetch("build")
  end

  def test_main_builds_all_installers
    # Psych versions using YAML 1.1 read the key 'on' as true.
    trigger = @entry["on"] || @entry.fetch(true)
    assert_equal({"branches" => ["main"]}, trigger.fetch("push"))
    assert_equal %w[aarch64-apple-darwin x86_64-apple-darwin x86_64-pc-windows-msvc],
      @build.dig("strategy", "matrix", "include").map { |target| target.fetch("triple") }.sort
    assert_equal false, @build.dig("strategy", "fail-fast")
    assert_equal "${{ needs.version.outputs.version }}", @jobs.dig("build", "with", "version")
    assert_equal "${{ needs.version.outputs.version }}", @jobs.fetch("publish").fetch("steps").last.dig("env", "RELEASE_VERSION")
  end

  def test_prs_report_a_fast_check_independent_of_full_platform_tests
    workflow = YAML.safe_load(File.read(File.expand_path("../workflows/pr-checks.yml", __dir__)))
    trigger = workflow["on"] || workflow.fetch(true)
    refute trigger.fetch("pull_request").key?("paths"), "Every PR needs a check result, including documentation changes"
    assert_equal({"contents" => "read"}, workflow.fetch("permissions"))
    assert_equal true, workflow.fetch("concurrency").fetch("cancel-in-progress")
    fast = workflow.fetch("jobs").fetch("fast")
    assert_equal "Build, type-check and smoke tests", fast.fetch("name")
    assert_equal "ubuntu-latest", fast.fetch("runs-on")
    refute fast.key?("needs")
    full = workflow.fetch("jobs").fetch("platforms")
    assert_equal "./.github/workflows/ci.yml", full.fetch("uses")
    refute full.key?("needs")
  end

  def test_closing_a_pr_cancels_its_checks_without_starting_another_build
    workflow = YAML.safe_load(File.read(File.expand_path("../workflows/pr-checks.yml", __dir__)))
    trigger = workflow["on"] || workflow.fetch(true)
    assert_equal %w[opened synchronize reopened closed].sort, trigger.fetch("pull_request").fetch("types").sort
    # The close joins the open PR's group, so it cancels what still runs there.
    assert_equal "pr-checks-${{ github.event.number }}", workflow.fetch("concurrency").fetch("group")
    assert_equal true, workflow.fetch("concurrency").fetch("cancel-in-progress")
    workflow.fetch("jobs").each_value { |job| assert_equal "github.event.action != 'closed'", job.fetch("if") }
  end

  def test_prs_compile_and_test_the_desktop_shell
    ci = YAML.safe_load(File.read(File.expand_path("../workflows/ci.yml", __dir__)))
    job = ci.fetch("jobs").fetch("build-and-test")
    rust = job.dig("strategy", "matrix", "include").to_h { |entry| [entry.fetch("name"), entry["rust"]] }
    assert_equal({"Linux" => nil, "macOS" => "always", "Windows" => "push", "Windows engine" => nil}, rust)
    assert_equal "${{ matrix.rust == 'always' || (matrix.rust == 'push' && github.event_name == 'push') }}",
      job.dig("env", "RUST_TESTS")
    setup = job.fetch("steps").find { |step| step["uses"] == "./.github/actions/setup" }
    assert_equal "${{ env.RUST_TESTS }}", setup.dig("with", "rust")
    tests = job.fetch("steps").find { |step| step["name"] == "Rust tests" }
    assert_equal "env.RUST_TESTS == 'true'", tests.fetch("if")
    assert_includes tests.fetch("run"), "cargo test --locked"
  end

  def test_every_action_outside_the_repository_is_pinned_to_a_commit
    files = Dir[File.expand_path("../{workflows,actions}/**/*.yml", __dir__)]
    refute_empty files
    files.each do |file|
      File.read(file).scan(/^\s*-?\s*uses:\s*(\S+)(.*)$/).each do |action, comment|
        next if action.start_with?("./")
        assert_match(/@[0-9a-f]{40}\z/, action, "#{File.basename(file)} uses #{action} by a tag or branch")
        assert_match(/\A\s+# \S+/, comment, "#{File.basename(file)} pins #{action} without naming its version")
      end
    end
  end

  def test_only_automatic_test_builds_share_runners_with_newer_main_pushes
    linux = YAML.safe_load(File.read(File.expand_path("../workflows/linux-desktop.yml", __dir__)))
    # Pushes that publish keep their own group in both, so a newer push never cancels a release's Linux package.
    [@entry, linux].each do |workflow|
      condition = "github.event_name == 'push' && github.run_attempt == '1' && vars.SCARLET_STABLE_RELEASES != 'true' && vars.SCARLET_STABLE_RELEASES != 'updater-signed'"
      assert_equal "${{ github.workflow }}-${{ #{condition} && github.ref || github.run_id }}",
        workflow.fetch("concurrency").fetch("group")
      assert_equal true, workflow.fetch("concurrency").fetch("cancel-in-progress")
    end
    refute_equal @entry.fetch("name"), linux.fetch("name")
  end

  def test_checks_and_native_builds_have_read_only_repository_access
    assert_equal({"contents" => "read"}, @entry.fetch("permissions"))
    %w[build version].each { |name| refute @jobs.fetch(name).key?("permissions") }
    refute @build.key?("permissions")
    refute @jobs.fetch("build").key?("secrets")
    assert_equal "${{ #{STABLE_RELEASE} }}", @jobs.dig("build", "with", "release")
    assert_equal "${{ !inputs.release || (!inputs.early_access && #{MAIN_PUSH}) }}", @build.fetch("if")
    assert_equal "${{ inputs.release && inputs.platform_signing && 'release' || 'desktop-build' }}", @build.fetch("environment")
    secret_steps = @build.fetch("steps").select { |step| step.to_s.include?("secrets.APPLE_") }
    assert_equal ["inputs.release && inputs.platform_signing && runner.os == 'macOS'"], secret_steps.map { |step| step.fetch("if") }
    assert_equal "${{ needs.version.outputs.signing == 'true' }}", @jobs.dig("build", "with", "platform_signing")
    refute_includes @build.to_s, "secrets.TAURI_SIGNING_PRIVATE_KEY"
    publish = @jobs.fetch("publish")
    assert_equal "release", publish.fetch("environment")
    updater_steps = publish.fetch("steps").select { |step| step.to_s.include?("secrets.TAURI_SIGNING_PRIVATE_KEY") }
    assert_equal 1, updater_steps.length
    signing = updater_steps.first
    assert_includes signing.fetch("run"), 'signer sign --app-version "$RELEASE_VERSION"'
    assert_operator publish.fetch("steps").index(signing), :<, publish.fetch("steps").index { |step| step.fetch("name", "").start_with?("Verify the update signatures") }
    [@jobs.fetch("version"), @build, @jobs.fetch("publish")].each do |job|
      assert_equal false, job.fetch("steps").first.fetch("with").fetch("persist-credentials")
    end
  end

  def test_early_access_is_an_explicit_read_only_dispatch
    trigger = @entry["on"] || @entry.fetch(true)
    input = trigger.fetch("workflow_dispatch").fetch("inputs").fetch("early_access_version")
    assert_equal "string", input.fetch("type")
    assert_equal false, input.fetch("required")
    assert_equal "${{ github.event_name == 'workflow_dispatch' && inputs.early_access_version != '' }}",
      @jobs.dig("build", "with", "early_access")
    resolve = @jobs.fetch("version").fetch("steps").last
    assert_equal "${{ inputs.early_access_version }}", resolve.dig("env", "EARLY_ACCESS_VERSION")
    assert_includes resolve.fetch("run"), 'release-version.mjs early-access "$EARLY_ACCESS_VERSION"'
    assert_includes @build.fetch("if"), "!inputs.early_access &&"
  end

  def test_only_main_can_publish_after_the_whole_matrix_passes
    publish = @jobs.fetch("publish")
    assert_equal STABLE_RELEASE, publish.fetch("if")
    assert_equal %w[version build ci], publish.fetch("needs")
    assert_equal "./.github/workflows/ci.yml", @jobs.dig("ci", "uses")
    assert_equal MAIN_PUSH, @jobs.dig("ci", "if")
    assert_equal({"contents" => "write"}, publish.fetch("permissions"))
    upload = @build.fetch("steps").find { |step| step["uses"].to_s.start_with?("actions/upload-artifact@") }
    refute upload.key?("if"), "Failed native jobs must not upload a release candidate"
    assert_equal "error", upload.fetch("with").fetch("if-no-files-found")
  end
end
