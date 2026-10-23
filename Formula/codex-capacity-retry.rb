class CodexCapacityRetry < Formula
  desc "Local desktop console for monitoring and recovering Codex tasks"
  homepage "https://github.com/berhannnnd/codex-capacity-retry"
  url "https://github.com/berhannnnd/codex-capacity-retry/archive/refs/tags/v0.2.0.tar.gz"
  sha256 "REPLACE_WITH_RELEASE_SHA256"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", "--ignore-scripts"
    libexec.install Dir["*"]
    (bin/"codex-capacity-retry").write <<~SH
      #!/bin/sh
      exec "#{libexec}/bin/codex-capacity-retry" "$@"
    SH
  end

  test do
    assert_match "Capacity Retry", shell_output("#{bin}/codex-capacity-retry --help 2>&1", 0)
  end
end
