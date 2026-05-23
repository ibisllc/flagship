# Reproducible static build of the flagship-unseal boot helper.
#
# The target is a CGO-free linux/amd64 binary with no dynamic dependencies, so
# it runs in a minimal initramfs before the LUKS root is unlocked. The build is
# deterministic: -trimpath strips local paths, -buildvcs=false drops VCS stamps,
# and ldflags -s -w drop the symbol/DWARF tables. Two clean builds on the same
# Go toolchain produce byte-identical output (see `make verify-reproducible`).

BINARY     := flagship-unseal
OUT_DIR    := dist
GOFLAGS    := -trimpath -buildvcs=false
LDFLAGS    := -s -w
BUILD_ENV  := CGO_ENABLED=0 GOOS=linux GOARCH=amd64

.PHONY: all build test vet clean verify-reproducible native

all: build

# The shipped artifact: static linux/amd64.
build:
	$(BUILD_ENV) go build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o $(OUT_DIR)/$(BINARY) .
	@echo "built $(OUT_DIR)/$(BINARY)"
	@ls -l $(OUT_DIR)/$(BINARY)

# Host-native build, handy for local poking; not the shipped artifact.
native:
	CGO_ENABLED=0 go build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o $(OUT_DIR)/$(BINARY)-native .

test:
	go test ./...

vet:
	go vet ./...

# Build twice and cmp the bytes — the proof the build is reproducible.
verify-reproducible:
	$(BUILD_ENV) go build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o $(OUT_DIR)/$(BINARY).a .
	$(BUILD_ENV) go build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o $(OUT_DIR)/$(BINARY).b .
	cmp $(OUT_DIR)/$(BINARY).a $(OUT_DIR)/$(BINARY).b && echo "REPRODUCIBLE: byte-identical"
	@rm -f $(OUT_DIR)/$(BINARY).a $(OUT_DIR)/$(BINARY).b

clean:
	rm -rf $(OUT_DIR)
