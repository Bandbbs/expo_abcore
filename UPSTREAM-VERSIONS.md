# Upstream Versions

The first public release is based on the following AstroBox revisions:

| Component | Revision |
| --- | --- |
| AstroBox-NG Core | `73d62d9e55ec2ea4391d75efd0984f85e9af72e9` |
| AstroBox-NG Pb | `03a92010056dd41af114f6f46fd612104b27bd7b` |
| AstroBox-NG Vivo MsgPack | `baa814b3d90454c127008a85ac307acf92b4914f` |
| AstroBox-NG Bluetooth | `91db36fe93ba3ebeb522f3ed9709ff3c9262a773` |
| AstroBox-NG Android SPP | `a660701883380ed25cd4c0284c574cb6b83a941b` |

The Rust components are retained as Git submodules at their full revisions.
The Bluetooth and Android SPP transports are adapted into the native platform
facades and retain their upstream attribution in `NOTICE`.
