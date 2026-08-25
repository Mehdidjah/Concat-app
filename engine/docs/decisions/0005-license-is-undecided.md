# 0005 - License: OPEN QUESTION

Not decided. Deliberately left blank in `Cargo.toml` rather than defaulted, because
this is your call and a silent default is hard to walk back.

The tension for an open-source editor:

- **MIT / Apache-2.0** - maximum adoption; anyone may ship a closed fork.
- **GPL-3.0** - forks stay open; awkward with proprietary plugin SDKs.
- **AGPL-3.0** - also covers a hosted or cloud fork.
- **MPL-2.0** - file-level copyleft; a middle ground that still permits
  proprietary plugins linking against the engine.

Note that FFmpeg is LGPL by default and GPL when built with `--enable-gpl`
components (x264 among them). Because we invoke it as a separate process rather
than linking it (see 0002), its license does not propagate to this code - but it
does constrain what a distributed *bundle* may be.

Pick one before the first public release, then delete this file.
