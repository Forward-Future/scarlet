require "minitest/autorun"
require "yaml"

class DesktopPermissionsTest < Minitest::Test
  MAIN_PUSH = "github.event_name == 'push' && github.ref == 'refs/heads/main'"
  STABLE_RELEASE = "#{MAIN_PUSH} && vars.SCARLET_STABLE_RELEASES == 'true'"

  def setup
    workflows = File.expand_path("../workflows", __dir__)
    @entry = YAML.safe_load(File.read(File.join(workflows, "desktop.yml")))
    @jobs = @entry.fetch("jobs")
    @build = YAML.safe_load(File.read(File.join(workflows, "desktop-build.yml"))).fetch("jobs").fetch("build")
  end

  def test_every_main_push_builds_all_installers
    # Psych versions using YAML 1.1 read the key 'on' as true.
    trigger = @entry["on"] || @entry.fetch(true)
    assert_equal({"branches" => ["main"]}, trigger.fetch("push"))
    refute @entry.key?("concurrency"), "A branch-wide lock can cancel a pending release"
    assert_equal %w[aarch64-apple-darwin x86_64-apple-darwin x86_64-pc-windows-msvc],
      @build.dig("strategy", "matrix", "include").map { |target| target.fetch("triple") }.sort
    assert_equal false, @build.dig("strategy", "fail-fast")
    assert_equal "${{ needs.version.outputs.version }}", @jobs.dig("build", "with", "version")
    assert_equal "${{ needs.version.outputs.version }}", @jobs.fetch("publish").fetch("steps").last.dig("env", "RELEASE_VERSION")
  end

  def test_checks_and_native_builds_have_read_only_repository_access
    assert_equal({"contents" => "read"}, @entry.fetch("permissions"))
    %w[build version].each { |name| refute @jobs.fetch(name).key?("permissions") }
    refute @build.key?("permissions")
    refute @jobs.fetch("build").key?("secrets")
    assert_equal "${{ #{STABLE_RELEASE} }}", @jobs.dig("build", "with", "release")
    assert_equal "${{ !inputs.release || (!inputs.early_access && #{MAIN_PUSH}) }}", @build.fetch("if")
    assert_equal "${{ inputs.release && 'release' || 'desktop-build' }}", @build.fetch("environment")
    secret_steps = @build.fetch("steps").select { |step| step.to_s.include?("secrets.APPLE_") }
    assert_equal ["inputs.release && runner.os == 'macOS'"], secret_steps.map { |step| step.fetch("if") }
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
