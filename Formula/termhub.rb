class Termhub < Formula
  desc "AI-native terminal control CLI"
  homepage "https://github.com/duo121/termhub"
  url "https://registry.npmjs.org/@duo121/termhub/-/termhub-0.6.4.tgz"
  sha256 "82403b90586e4f7899869a8fdba754bb8782384a9d8cae11901189970e1fc132"
  license "MIT"

  depends_on "node"
  depends_on :macos

  def install
    system "npm", "install", *std_npm_args
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/termhub --version")
  end
end
