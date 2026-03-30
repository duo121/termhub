class Termhub < Formula
  desc "AI-native terminal control CLI"
  homepage "https://github.com/duo121/termhub"
  url "https://registry.npmjs.org/@duo121/termhub/-/termhub-0.6.1.tgz"
  sha256 "b0b1e402b9f89660ce91a94cbcb0cdd45ab6b5a97da8f28cc7dbe0dbf8aea077"
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
