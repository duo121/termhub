class Termhub < Formula
  desc "AI-native terminal control CLI"
  homepage "https://github.com/duo121/termhub"
  url "https://registry.npmjs.org/@duo121/termhub/-/termhub-0.6.3.tgz"
  sha256 "fb2a96e65703f572f3ad3c3133ab5f0c39f4982e1298ab91eae01167ec77df53"
  license :cannot_represent

  depends_on "node"
  depends_on :macos

  def install
    system "npm", "install", *std_npm_args
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/termhub --version")
  end
end
