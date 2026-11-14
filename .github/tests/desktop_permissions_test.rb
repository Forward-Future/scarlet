require "minitest/autorun"
require "yaml"

class DesktopPermissionsTest < Minitest::Test
  MAIN_PUSH = "github.event_name == 'push' && github.ref == 'refs/heads/main'"
  STABLE_RELEASE = "#{MAIN_PUSH} && vars.SCARLET_STABLE_RELEASES == 'true'"

  def setup
    workflows = File.expand_path("../workflows", __dir__)
    @entry = YAML.safe_load(File.read(File.join(workflows, "desktop.yml")))
    @unsigned = YAML.safe_load(File.read(File.join(workflows, "desktop-unsigned-once.yml")))
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

  def test_unsigned_exception_has_one_source_one_version_and_no_inputs
    assert_equal "workflow_dispatch", @unsigned["on"] || @unsigned.fetch(true)
    pins = @unsigned.fetch("env")
    assert_match(/\A[0-9a-f]{40}\z/, pins.fetch("RELEASE_SOURCE_SHA"))
    assert_match(/\A\d+\.\d+\.\d+\z/, pins.fetch("RELEASE_VERSION"))
    jobs = @unsigned.fetch("jobs")
    assert_equal %w[publish verify], jobs.keys.sort
    expected_guard = "github.repository == 'Forward-Future/scarlet' && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'"
    jobs.each_value { |job| assert_equal expected_guard, job.fetch("if") }
    verify = jobs.fetch("verify")
    pin_step = verify.fetch("steps").find { |step| step["id"] == "source" }.fetch("run")
    assert_includes pin_step, 'git merge-base --is-ancestor "$RELEASE_SOURCE_SHA" "$GITHUB_SHA"'
    assert_includes pin_step, 'git worktree add --detach "$RUNNER_TEMP/approved-source" "$RELEASE_SOURCE_SHA"'
    assert_includes pin_step, '[[ "$(node apps/desktop/scripts/release-version.mjs for-commit)" == "$RELEASE_VERSION" ]]'
    assert_equal "verify", jobs.dig("publish", "needs")
  end

  def test_unsigned_publisher_uses_only_artifacts_verified_in_this_run
    jobs = @unsigned.fetch("jobs")
    assert_equal({"contents" => "read"}, @unsigned.fetch("permissions"))
    assert_equal({"contents" => "read", "actions" => "read"}, jobs.dig("verify", "permissions"))
    assert_equal({"contents" => "write", "actions" => "read"}, jobs.dig("publish", "permissions"))
    verification = jobs.dig("verify", "steps")
    staging = verification.last
    assert_equal "python3 .github/scripts/verify-unsigned-desktop-build.py installers", verification[-3].fetch("run")
    assert_equal "manifest", verification[-2].fetch("id")
    assert_includes verification[-2].fetch("run"), "sha256sum -- Scarlet-*"
    assert_equal "${{ steps.manifest.outputs.sha256 }}", jobs.dig("verify", "outputs", "manifest_sha256")
    assert_equal "${{ steps.stage.outputs.artifact-id }}", jobs.dig("verify", "outputs", "artifact_id")
    assert_equal "stage", staging.fetch("id")
    assert_match(/actions\/upload-artifact@/, staging.fetch("uses"))
    assert_equal "error", staging.dig("with", "if-no-files-found")
    assert_equal "installers/", staging.dig("with", "path")
    publishing = jobs.dig("publish", "steps")
    download = publishing[-3]
    assert_match(/actions\/download-artifact@/, download.fetch("uses"))
    assert_equal({"artifact-ids" => "${{ needs.verify.outputs.artifact_id }}", "merge-multiple" => true, "path" => "installers"}, download.fetch("with"))
    assert_equal "${{ needs.verify.outputs.manifest_sha256 }}", publishing[-2].dig("env", "EXPECTED_MANIFEST_SHA256")
    assert_includes publishing[-2].fetch("run"), "sha256sum --check --strict"
    assert_includes publishing[-2].fetch("run"), "sha256sum -- Scarlet-*"
    assert_equal 'node .github/scripts/publish-desktop-release.mjs "$RELEASE_VERSION" installers --unsigned-once', publishing.last.fetch("run")
    assert_equal @jobs.dig("publish", "concurrency", "group").sub("needs.version.", "needs.verify."),
      jobs.dig("publish", "concurrency", "group")
  end
end
