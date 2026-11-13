require "minitest/autorun"
require "yaml"

class DesktopPermissionsTest < Minitest::Test
  def setup
    workflows = File.expand_path("../workflows", __dir__)
    @entry = YAML.safe_load(File.read(File.join(workflows, "desktop.yml")))
    @build = YAML.safe_load(File.read(File.join(workflows, "desktop-build.yml"))).fetch("jobs").fetch("build")
  end

  def test_pull_request_and_manual_checks_have_only_read_access
    check = @entry.fetch("jobs").fetch("check")
    assert_equal({"contents" => "read"}, @entry.fetch("permissions"))
    assert_equal "github.event_name != 'push' || !github.ref_protected", check.fetch("if")
    assert_equal false, check.fetch("with").fetch("release")
    refute check.key?("secrets")
    refute check.key?("permissions")
  end

  def test_only_a_protected_release_tag_can_select_the_signing_environment
    release = @entry.fetch("jobs").fetch("release")
    gate = "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') && github.ref_protected"
    assert_equal gate, release.fetch("if")
    assert_equal true, release.fetch("with").fetch("release")
    assert_equal({"contents" => "write"}, release.fetch("permissions"))
    refute release.key?("secrets")
    assert_equal "${{ !inputs.release || (" + gate + ") }}", @build.fetch("if")
    assert_equal "${{ inputs.release && 'release' || 'desktop-build' }}", @build.fetch("environment")
    sensitive = @build.fetch("steps").select { |step| step.to_s.include?("secrets.APPLE_") }
    assert_equal ["inputs.release && runner.os == 'macOS'"], sensitive.map { |step| step.fetch("if") }
    assert_equal false, @build.fetch("steps").first.fetch("with").fetch("persist-credentials")
  end
end
