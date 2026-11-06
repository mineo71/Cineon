PROJECT := Cineon.xcodeproj
SCHEME  := Cineon
DERIVED := build
DIST    := dist

.PHONY: all project debug run test e2e filters assets install release clean

all: project
	xcodebuild -project $(PROJECT) -scheme $(SCHEME) -configuration Release \
		-derivedDataPath $(DERIVED) -destination 'generic/platform=macOS' \
		-quiet build
	rm -rf $(DIST)/Cineon.app
	mkdir -p $(DIST)
	cp -R $(DERIVED)/Build/Products/Release/Cineon.app $(DIST)/Cineon.app
	@echo "Built $(DIST)/Cineon.app"

project:
	xcodegen generate --quiet
	@# XcodeGen doesn't know Icon Composer documents yet. Xcode needs this type to compile them.
	@sed -i '' -E 's/(AppIcon\.icon.*)(lastKnownFileType = )[^;]+;/\1\2folder.iconcomposer.icon;/' $(PROJECT)/project.pbxproj
	@grep -q 'folder.iconcomposer.icon' $(PROJECT)/project.pbxproj || (echo "App icon type not set" && exit 1)

debug: project
	xcodebuild -project $(PROJECT) -scheme $(SCHEME) -configuration Debug \
		-derivedDataPath $(DERIVED) -destination 'platform=macOS,arch=arm64' \
		-quiet build

run: all
	open $(DIST)/Cineon.app

test: project
	xcodebuild -project $(PROJECT) -scheme $(SCHEME) -configuration Debug \
		-derivedDataPath $(DERIVED) -destination 'platform=macOS,arch=arm64' \
		-quiet test

e2e: debug fixtures/film.mp4 fixtures/hls/index.m3u8
	python3 fixtures/e2e.py

fixtures/hls/index.m3u8: fixtures/film.mp4
	mkdir -p fixtures/hls
	ffmpeg -y -loglevel error -i fixtures/film.mp4 -c copy -f hls -hls_time 30 -hls_playlist_type vod \
		-hls_segment_filename fixtures/hls/seg%03d.ts fixtures/hls/index.m3u8

fixtures/film.mp4:
	ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=640x360:rate=12" -f lavfi -i "sine=frequency=330:sample_rate=22050" -t 900 \
		-c:v libx264 -preset ultrafast -crf 34 -pix_fmt yuv420p -c:a aac -b:a 32k -movflags +faststart fixtures/film.mp4
	ffmpeg -y -loglevel error -f lavfi -i "testsrc=size=320x180:rate=10" -t 30 \
		-c:v libx264 -preset ultrafast -crf 36 -pix_fmt yuv420p -movflags +faststart fixtures/short.mp4

filters:
	./scripts/fetch_filters.sh

assets:
	python3 scripts/make_assets.py

install: all
	rm -rf /Applications/Cineon.app
	cp -R $(DIST)/Cineon.app /Applications/Cineon.app
	@echo "Installed /Applications/Cineon.app"

# make release VERSION=1.2.0 (see scripts/release.sh)
release:
	./scripts/release.sh $(VERSION)

clean:
	rm -rf $(DERIVED) $(DIST) $(PROJECT)
