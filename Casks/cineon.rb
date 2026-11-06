cask "cineon" do
  version "0.0.0"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://github.com/mineo71/Cineon/releases/download/v#{version}/Cineon-#{version}.dmg",
      verified: "github.com/mineo71/Cineon/"
  name "Cineon"
  desc "Browser for watching films and series that remembers where you stopped"
  homepage "https://github.com/mineo71/Cineon"

  livecheck do
    url :url
    strategy :github_latest
  end

  # Cineon updates itself through Sparkle.
  auto_updates true
  depends_on macos: ">= :tahoe"

  app "Cineon.app"

  # The app isn't notarized, so drop the quarantine flag that would make Gatekeeper refuse it.
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/Cineon.app"]
  end

  zap trash: [
    "~/Library/Application Support/Cineon",
    "~/Library/Caches/app.cineon.Cineon",
    "~/Library/HTTPStorages/app.cineon.Cineon",
    "~/Library/Preferences/app.cineon.Cineon.plist",
    "~/Library/Saved Application State/app.cineon.Cineon.savedState",
    "~/Library/WebKit/app.cineon.Cineon",
  ]
end
