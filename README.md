# Looper

Looper de guitarra como app web (funciona en iPhone, Android y computadora).

**Versión 1:** grabar un loop, pausar y borrar. Una sola capa.

## Archivos

| Archivo | Para qué sirve |
|---|---|
| `index.html` | Pantalla y botones |
| `style.css` | Colores y tamaños |
| `app.js` | Lógica: grabar, cerrar el loop, pausar y borrar |
| `recorder-worklet.js` | Captura el audio con precisión de muestra |
| `manifest.json`, `icon*` | Permiten instalarla en la pantalla de inicio |
| `sw.js` | Guarda una copia para usarla sin internet |
| `servidor-local.js` | Solo para probarla en la computadora: `node servidor-local.js` |

## Notas

- El micrófono solo funciona en `https://` (o en `localhost`).
- La entrada no se manda a la bocina, para evitar acoples; solo suena el loop.
- Pedal Bluetooth o teclado: Espacio/↓ = grabar o cerrar, ↑ = pausar, Supr = borrar.
