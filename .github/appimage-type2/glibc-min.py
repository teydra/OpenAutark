#!/usr/bin/env python3
"""Lowest glibc a Linux AppImage needs: the highest GLIBC_x.y symbol version that any ELF file in it requires.

usage: glibc-min.py <AppImage>

Owns: measuring, for the AppImage runtime (the ELF in front of the squashfs) and for every ELF file inside the
squashfs separately, which GLIBC_ (and GLIBCXX_) symbol versions it requires from the system. It reads only; it
extracts the image with unsquashfs (no FUSE, no execution of the AppImage).
"""
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile

GLIBC = re.compile(r'GLIBC_(\d+(?:\.\d+)+)')
GLIBCXX = re.compile(r'GLIBCXX_(\d+(?:\.\d+)+)')


def vkey(v):
    return tuple(int(p) for p in v.split('.'))


def squashfs_offset(path):
    with open(path, 'rb') as f:
        head = f.read(64)
        assert head[:4] == b'\x7fELF' and head[4] == 2, 'not a 64-bit ELF runtime'
        shoff, = struct.unpack_from('<Q', head, 0x28)
        shentsize, shnum = struct.unpack_from('<HH', head, 0x3A)
        end = shoff + shentsize * shnum
        f.seek(end)
        if f.read(4) == b'hsqs':
            return end
        # fall back to the first squashfs magic after the ELF header
        f.seek(0)
        data = f.read(8 * 1024 * 1024)
        i = data.find(b'hsqs')
        assert i > 0, 'no squashfs found'
        return i


def required(path):
    """(glibc versions, glibcxx versions) that this ELF imports (undefined symbols only)."""
    out = subprocess.run(['objdump', '-T', path], capture_output=True, text=True).stdout
    g, x = set(), set()
    for line in out.splitlines():
        if '*UND*' not in line:
            continue
        g.update(GLIBC.findall(line))
        x.update(GLIBCXX.findall(line))
    return g, x


def is_elf(path):
    try:
        with open(path, 'rb') as f:
            return f.read(4) == b'\x7fELF'
    except OSError:
        return False


def report(label, files):
    rows = []
    for p in files:
        g, x = required(p)
        rows.append((max(g, key=vkey) if g else None, max(x, key=vkey) if x else None, p))
    with_g = [r for r in rows if r[0]]
    with_g.sort(key=lambda r: vkey(r[0]), reverse=True)
    print(f'--- {label}: {len(rows)} ELF files, {len(with_g)} import GLIBC_ symbols')
    for r in with_g[:8]:
        print(f'    GLIBC_{r[0]:<6} {r[2]}')
    top = with_g[0][0] if with_g else None
    topx = max((r[1] for r in rows if r[1]), key=vkey, default=None)
    print(f'=== {label}: highest GLIBC_ required = {("GLIBC_" + top) if top else "none (statically linked / no glibc imports)"}'
          f'; highest GLIBCXX_ = {("GLIBCXX_" + topx) if topx else "none"}')
    return top


def main():
    image = os.path.abspath(sys.argv[1])
    off = squashfs_offset(image)
    work = tempfile.mkdtemp(prefix='glibc-min-')
    try:
        print(f'image {os.path.basename(image)}: {os.path.getsize(image)} bytes, runtime = first {off} bytes')
        with open(image, 'rb') as f:
            magic = f.read(11)
        print(f'bytes 8..10 (AppImage type marker): {magic[8:11]!r}')
        runtime = os.path.join(work, 'runtime.elf')
        with open(image, 'rb') as src, open(runtime, 'wb') as dst:
            dst.write(src.read(off))
        print(subprocess.run(['file', '-b', runtime], capture_output=True, text=True).stdout.strip())
        dyn = subprocess.run(['readelf', '-d', runtime], capture_output=True, text=True)
        needed = re.findall(r'\(NEEDED\)\s+Shared library: \[(.+?)\]', dyn.stdout)
        print('runtime NEEDED libraries:', needed if needed else 'none (no dynamic section: statically linked)')
        fuse = subprocess.run(['strings', '-a', runtime], capture_output=True, text=True).stdout
        print('runtime mentions:', sorted({m for m in re.findall(r'libfuse[\w.\-]*|fusermount3?|AppImage runtime[^\n]{0,60}|type2-runtime[^\n]{0,60}', fuse)})[:12])
        rt = report('RUNTIME', [runtime])

        tree = os.path.join(work, 'tree')
        r = subprocess.run(['unsquashfs', '-no-progress', '-q', '-d', tree, '-o', str(off), image],
                           capture_output=True, text=True)
        assert r.returncode == 0, 'unsquashfs failed: ' + r.stderr[-400:]
        files = []
        for base, _dirs, names in os.walk(tree):
            for n in names:
                p = os.path.join(base, n)
                if not os.path.islink(p) and is_elf(p):
                    files.append(p)
        files = sorted(files)
        # show paths relative to the AppDir
        rows = []
        for p in files:
            g, x = required(p)
            rows.append((max(g, key=vkey) if g else None, os.path.relpath(p, tree)))
        with_g = sorted((r for r in rows if r[0]), key=lambda r: vkey(r[0]), reverse=True)
        print(f'--- APPDIR (squashfs content): {len(rows)} ELF files, {len(with_g)} import GLIBC_ symbols')
        for r in with_g[:10]:
            print(f'    GLIBC_{r[0]:<6} {r[1]}')
        body = with_g[0][0] if with_g else None
        print(f'=== APPDIR: highest GLIBC_ required = {("GLIBC_" + body) if body else "none"}')
        both = [v for v in (rt, body) if v]
        print(f'=== ALL (runtime + content): glibc minimum = {max(both, key=vkey) if both else "none"}')
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    main()
