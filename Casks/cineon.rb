cask "cineon" do
  version "1.0.0"
  sha256 "2c52c8bfcbbf34787a49c92ec3462c587e52e6eef935134b436733b8a3a95fb5"

  url "https://github.com/mineo71/Cineon/releases/download/v#{version}/Cineon-#{version}.dmg"
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
