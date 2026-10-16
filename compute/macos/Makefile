# Keeta Compute macOS app.
#   make project   generate KeetaCompute.xcodeproj from project.yml (needs xcodegen)
#   make build     build the app (Debug by default: make build CONFIGURATION=Release)
#   make test      run the KeetaComputeKit unit tests with SwiftPM
#   make xctest    run the same tests through the Xcode project
#   make run       build and open the app

PROJECT       := KeetaCompute.xcodeproj
SCHEME        := KeetaCompute
TEST_SCHEME   := KeetaComputeKitTests
CONFIGURATION ?= Debug
DERIVED_DATA  := build/DerivedData
DESTINATION   := platform=macOS,arch=arm64
XCODEBUILD    := xcodebuild -project $(PROJECT) -derivedDataPath $(DERIVED_DATA) -destination '$(DESTINATION)'
TEAM_FLAG     := $(if $(DEVELOPMENT_TEAM),DEVELOPMENT_TEAM=$(DEVELOPMENT_TEAM),)
APP           := $(DERIVED_DATA)/Build/Products/$(CONFIGURATION)/Keeta Compute.app

.PHONY: project build test xctest run clean

project:
	@command -v xcodegen >/dev/null || { echo "xcodegen is required: brew install xcodegen"; exit 1; }
	xcodegen generate

build: project
	$(XCODEBUILD) -scheme $(SCHEME) -configuration $(CONFIGURATION) $(TEAM_FLAG) build

test:
	swift test

xctest: project
	$(XCODEBUILD) -scheme $(TEST_SCHEME) -configuration Debug CODE_SIGNING_ALLOWED=NO test

run: build
	open "$(APP)"

clean:
	rm -rf build .build $(PROJECT)
