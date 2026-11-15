# Dependencias vendorizadas del hook

Dependencias sin instalación global ni `node_modules`. El hook verifica en cada ejecución el SHA-256 de
cada archivo contra `lib/vendor.mjs`; si no coincide, falla cerrado (exit 2).

| Paquete | Versión | Publicado en npm | Licencia | Procedencia |
|---|---|---|---|---|
| `web-tree-sitter` | 0.27.1 | 2026-10-08 | MIT | `npm pack web-tree-sitter@0.27.1` (repo `tree-sitter/tree-sitter`, `lib/binding_web`) |
| `tree-sitter-bash` | 0.25.1 | 2025-12-02 | MIT | `npm pack tree-sitter-bash@0.25.1` (repo `tree-sitter/tree-sitter-bash`) |

Descargado el 2026-11-03 con `npm pack` (sin `npm install`, sin scripts de instalación).

## Tarballs de origen

| Tarball | npm shasum (SHA-1) | npm integrity | SHA-256 |
|---|---|---|---|
| `web-tree-sitter-0.27.1.tgz` | `a3ee99cba502fa3a9a6b29d14d9964ceb4e98666` | `sha512-qtx0VyUyNRHtL3ze7+v0hCKB/sLcAmY7ZAVp/ZK/bCj0yED8ptvNrr7Vd7DwDyKDWN9baqcUx4uaD2r2ql+6IA==` | `7346db659eb870a5284242851ab7aedea41d7397b8c7e95ff8d9ec5b5a80270f` |
| `tree-sitter-bash-0.25.1.tgz` | `78499ecf8930db57bfe46581f948387ed78a0470` | `sha512-7hMytuYIMoXOq24yRulgIxthE9YmggZIOHCyPTTuJcu6EU54tYD+4G39cUb28kxC6jMf/AbPfWGLQtgPTdh3xw==` | `d4b2819508ea97cb8953fff7e304a610d443007bd395c8f03a15de9a8ae4a6f9` |

## Archivos copiados (sin modificar)

| Archivo | Origen en el tarball | SHA-256 |
|---|---|---|
| `web-tree-sitter/web-tree-sitter.js` | `package/web-tree-sitter.js` | `7c49e3c1d87e24e0bb4c2def909d17154dfde281f5f8280225450090bb4b8110` |
| `web-tree-sitter/web-tree-sitter.wasm` | `package/web-tree-sitter.wasm` | `beca80e44cccbf2299ed4d1e3fa6462a9a6fe818aeebf847547a392227ce4acc` |
| `web-tree-sitter/LICENSE` | `package/LICENSE` | `c5cfb43042b6b72045f4ba997834d0a7786d2793d91680868b5815b39f14fc78` |
| `tree-sitter-bash/tree-sitter-bash.wasm` | `package/tree-sitter-bash.wasm` (ABI 15) | `8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a` |
| `tree-sitter-bash/LICENSE` | `package/LICENSE` | `49bf33cf78ef5897e4e161ce1517df7de1ae5042a65b6bcfd44401e0fc606559` |

## Límites conocidos

`tree-sitter-bash` es una gramática que aproxima bash; no es bash. Puede diferir en casos límite
(caracteres de control, construcciones raras, extensiones). El hook no le atribuye garantías:
bloquea caracteres sospechosos, nodos `ERROR`/`MISSING` con vocabulario sensible y construcciones
dinámicas. Ver `.claude/rules/governance.md` (riesgos residuales).

## Actualizar

Sólo con pedido explícito del owner: `npm pack` de la nueva versión en un directorio vacío, copiar
los mismos archivos, recalcular SHA-256, actualizar esta tabla y `lib/vendor.mjs`, y correr
`node --test .claude/hooks/test/`.
