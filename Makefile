.PHONY: install test typecheck build web daemon build-image keygen clean

install:
	npm install

test:
	npx vitest run

test-watch:
	npx vitest

typecheck:
	npx tsc -b

build: typecheck

web:
	npm --workspace=@flagship/web run dev

daemon:
	FLAGSHIP_CONFIG=$${FLAGSHIP_CONFIG:-./tools/example-server.json} \
	  npm --workspace=@flagship/server-daemon run start

# Example: make build-image SPEC=tools/example-spec.json OUT=./build-out
build-image:
	npm --workspace=@flagship/bootkey-builder run start -- --spec $(SPEC) --out $(OUT)

keygen:
	npx tsx tools/keygen.ts

clean:
	rm -rf node_modules packages/*/dist apps/*/dist apps/web/dist build-out
