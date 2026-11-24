# Linux AppImage on the Type-2 static runtime (task_gcje1607)

State 24.11.2026, branch `feature/appimage-type2`, measured by the workflow `AppImage Type-2 check` (CI run 45315440209,
commit 4874247, runner ubuntu-24.04 image 20261116). Nothing here touches 0.3.19.

## The setting

electron-builder 26.15.3 reads the AppImage toolset from the **top level** of the build configuration, not from
`build.appImage`:

```json
"build": { "toolsets": { "appimage": "1.0.3" } }
```

Values (app-builder-lib 26.15.3, `scheme.json` → `ToolsetConfig.appimage`): `"0.0.0"` is the legacy FUSE2 toolset
(`appimage-12.0.1.7z`, the default when unset), `"1.0.2"` and `"1.0.3"` are the static-runtime toolsets
(`appimage-tools-runtime-20251108.tar.gz`; the schema calls both betas, 1.0.3 resolves electron-builder issue #9598).
We use 1.0.3. The build log and the artifact confirm it: the runtime in front of the squashfs is the
`AppImage/type2-runtime` commit `dd6cebe`, static-pie, no dynamic section.

Two changes follow from the toolset that the config does not show:

- Compression is zstd (legacy: gzip). The same app: 153.0 MB (Type-2) against 164.3 MB (legacy).
- The desktop entry's `Exec=` no longer gets `--no-sandbox`. `AppRun` adds it only when `unshare -Ur true` fails
  (user namespaces refused, as on the CI runner). Where user namespaces work, Chromium's sandbox now runs.

## What the CI shows (type2 = new runtime, legacy = control built from the same unpacked app)

| | Type-2 | Legacy (toolsets.appimage 0.0.0) |
|---|---|---|
| a) `dpkg -s libfuse2 libfuse2t64` | both "not installed" (exit 1), `ldconfig` knows no `libfuse.so.2` | same |
| b) type | `AI\x02` at offset 8; ELF static-pie; `--appimage-version`: type2-runtime commit dd6cebe | `AI\x02`; ELF dynamically linked (needs libdl, libpthread, libz, libc; dlopens `libfuse.so.2`) |
| c) start under xvfb, no `--appimage-extract-and-run` | **alive after 25 s**, window "Autark" 1180x800 | **exits after 1 s**: `dlopen(): error loading libfuse.so.2 – AppImages require FUSE to run.` |
| d) keyring | see below, identical | identical (run with extract-and-run, since it cannot start otherwise) |
| e) glibc minimum | runtime: none (static); content: **GLIBC_2.32**; overall **2.32** | runtime: GLIBC_2.3.3; content: GLIBC_2.32; overall **2.32** |

Summary of c): the runner has no libfuse2 by default; the Type-2 build mounts through `fusermount3` (package `fuse3`,
present on the runner). With `fusermount` and `fusermount3` hidden it stops with `No suitable fusermount binary found on
the $PATH` (exit 127); with `APPIMAGE_EXTRACT_AND_RUN=1` it starts without any FUSE. So: no libfuse2 needed, a fuse3
helper still is.

### e) glibc, per file

The switch of the runtime does not lower the minimum. The highest requirement is in the content, not in the runtime:

```
GLIBC_2.32  resources/app.asar.unpacked/node_modules/sherpa-onnx-linux-x64/sherpa-onnx.node
GLIBC_2.25  autark (the Electron binary)
GLIBC_2.17  chrome_crashpad_handler, libffmpeg.so, libvk_swiftshader.so
```

So Autark needs glibc ≥ 2.32 (Ubuntu 22.04 and newer, Debian 12, Fedora 33, RHEL 9; not Ubuntu 20.04 with 2.31, Debian 11 with 2.31, RHEL 8 with 2.28) with either runtime; without the sherpa-onnx
voice module it would be 2.25. The legacy runtime itself asks only GLIBC_2.3.3, the new one nothing (static).

### d) keyring (Electron 45.4.1, safeStorage)

| Scenario | `isEncryptionAvailable()` | `isAsyncEncryptionAvailable()` | backend | window |
|---|---|---|---|---|
| gnome-keyring running and unlocked, default flags (`XDG_CURRENT_DESKTOP=GNOME`) | true | true | `gnome_libsecret` | normal shell |
| same with `--password-store=gnome-libsecret` | true | true | `gnome_libsecret` | normal shell |
| no D-Bus session (Secret Service unreachable) | **false** | **true** | `gnome_libsecret` | **normal shell**, no repair card |

Type-2 and legacy give the same lines. Not caused by the runtime, but visible in this test: `host-services.ts`
(`storageProblem`) asks `isAsyncEncryptionAvailable()`, which stays true without any Secret Service, so a start without a
keyring shows the normal shell instead of "Autark needs an unlocked system keyring". The repository test
`test/ui/linux-keyring-appimage.test.mjs` therefore fails on both builds at its first launch without a keyring
(`REPO-TEST … rc=1` in both jobs; reported, not fatal, in this workflow). A synthetic encrypt/decrypt round trip also
succeeds without a bus (`asyncRoundTrip: ok`), which means Chromium may be using its fixed-key fallback there. That
needs a decision in the app, not in the packaging.

## Reproduce

Push to `feature/appimage-type2` or run the workflow by hand. `checks.sh a|b|c|c2|d|e` holds each check,
`glibc-min.py` the glibc measurement, `probe-backend.mjs` the keyring probe.
