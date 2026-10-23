class CodexCapacityRetry < Formula
  desc "Local desktop console for monitoring and recovering Codex tasks"
  homepage "https://github.com/berhannnnd/codex-capacity-retry"
  head "https://github.com/berhannnnd/codex-capacity-retry.git", branch: "main"
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
    assert_match "Codex", shell_output("#{bin}/codex-capacity-retry --help 2>&1", 0)
  end
end
