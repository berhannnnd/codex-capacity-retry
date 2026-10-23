class CodexCapacityRetry < Formula
  desc "Local desktop console for monitoring and recovering Codex tasks"
  homepage "https://github.com/berhannnnd/codex-capacity-retry"
  url "https://github.com/berhannnnd/codex-capacity-retry/archive/refs/tags/v0.2.0.tar.gz"
  sha256 "0d6907771fcbb1ed0c3e5542c3c13e7d79545d2390f656313e7e69b019f43d0d"
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
