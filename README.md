# ImageTo3D

App de escritorio para Windows que convierte un PNG (o JPG, WEBP, SVG o un texto) en un logo 3D extruido, permite darle material, iluminación y animación (intro, bucle y salida), y lo exporta como vídeo MP4, WebM o AVI (los dos con transparencia), secuencia PNG, imagen PNG o modelo GLB/STL.

Funciona sin conexión: todo se renderiza en local, con la GPU.

## Descargar

Descarga `ImageTo3D-Setup-<versión>.exe` desde la [última versión](https://github.com/joseramos1999/ImageTo3D/releases/latest) y ejecútalo. Funciona en Windows 10 y 11 de 64 bits, sin instalar nada más (lleva .NET dentro). Se instala para tu usuario, sin pedir administrador.

El instalador no está firmado, así que la primera vez Windows SmartScreen mostrará «Windows protegió su PC»: pulsa **Más información** → **Ejecutar de todas formas**.

Desde la 1.0.1 la app se actualiza sola: al arrancar (y cada 12 h) consulta la última versión en GitHub y, si hay una nueva, avisa con sus novedades. «Actualizar ahora» descarga el instalador, comprueba su huella SHA-256 con la publicada en GitHub, lo instala en silencio y vuelve a abrir la app, conservando proyectos y recientes. También se puede comprobar a mano pulsando el número de versión en la barra superior.

## Qué hace

- **Recorte:** separa el logo del fondo de forma automática (transparencia o color del borde), por transparencia, por color (con cuentagotas) o por luminosidad. Tiene umbral, limpieza de ruido, inversión, relleno de agujeros y una vista previa antes / comparar / después.
- **Geometría:** profundidad, bisel, suavizado y escala.
- **Aspecto:** 24 materiales, 6 iluminaciones con dirección de la luz arrastrable, 5 suelos, 13 fondos (incluido Transparente), bloom con tamaño del halo, destello que barre el logo, partículas y 12 movimientos de cámara con intensidad regulable.
- **Animación:** 137 animaciones (57 bucles, 41 intros y 39 salidas; algunas revelan el logo con planos de recorte) que se encadenan en la pestaña **Secuencia** (intro → bucle × N repeticiones → salida, con uniones suaves; la duración sale de las partes); y 21 estilos **Predeterminados** que aplican la escena completa con un clic.
- **Proyectos:** archivos `.i3d` con la imagen incrustada, menú de recientes, recuperación automática al reiniciar y deshacer / rehacer.
- **Exportación:** MP4, WebM (con canal alfa si el fondo es transparente), AVI en Motion JPEG (el más compatible) o sin compresión con canal alfa (como el códec «Ninguno» con «RGB + alfa» de After Effects) y secuencia PNG en ZIP, hasta 4K60, escritos a disco mientras se renderizan y con bucle perfecto; PNG, GLB y STL en milímetros. Tamaños predefinidos (YouTube, Shorts/Reels/TikTok, Instagram 1:1 y 4:5, 4:3, 21:9…) o personalizado.

## Arquitectura

```
ImageTo3D.exe (WPF, .NET 10)
 └─ WebView2 (Chromium de Edge, viene con Windows 11)
     └─ https://app.imageto3d/  →  carpeta wwwroot/ (host virtual, sin servidor)
         ├─ js/imaging.js         dimensiones por cabecera, límites, decodificación ya reducida
         ├─ js/pipeline*.js       Web Worker: trazado, textura de color y vista previa del recorte
         │   ├─ js/trace.js       llave de recorte → campo de "tinta" → marching squares interpolado → contornos
         │   └─ js/colormap.js    textura de color sin halos (erosión + dilatación + push-pull)
         ├─ js/geometry.js        contornos → ExtrudeGeometry con bisel y UV planares (hilo principal)
         ├─ js/materials.js       24 materiales
         ├─ js/animations.js      137 animaciones, funciones puras del tiempo
         ├─ js/presets.js         21 estilos predeterminados
         ├─ js/sequence-ui.js     pestaña Secuencia: intro, bucle × N y salida
         ├─ js/stage.js           render, luces, suelos, fondos, bloom, partículas, cámara
         ├─ js/exporter.js        MP4 (H.264), WebM (VP9, con alfa), AVI (Motion JPEG o RGBA sin compresión, OpenDML, js/avi.js), secuencia PNG (js/zip.js), PNG, GLB, STL
         ├─ js/formats.js         tamaños de salida predefinidos y personalizado
         ├─ js/filesink.js        escritura del vídeo a disco a través del host
         ├─ js/project.js         formato .i3d e historial de deshacer
         ├─ js/store.js           IndexedDB: recientes y recuperación
         └─ js/app.js, mask-ui.js interfaz ↔ motor
```

El host en C# ([MainWindow.xaml.cs](src/ImageTo3D/MainWindow.xaml.cs) y [UpdateService.cs](src/ImageTo3D/UpdateService.cs)) se encarga de:
- mostrar el diálogo nativo "Guardar como" al exportar;
- escribir en disco los vídeos que llegan por trozos;
- abrir los `.i3d` que se le pasan por línea de comandos (doble clic en el Explorador);
- mostrar una pantalla de error con "Reintentar" si el motor no arranca o WebView2 falla;
- buscar versiones nuevas en GitHub Releases, descargar el instalador verificado y relanzarse actualizado (para probarlo sin GitHub, la variable de entorno `IMAGETO3D_UPDATE_URL` apunta a un JSON con la forma de la API).

### Decisiones clave

- **Trazado con precisión de subpíxel.** La máscara no se umbraliza: marching squares interpola sobre el canal alfa (o sobre la distancia de color al fondo en imágenes opacas). Así un logo con antialiasing da contornos suaves sin escalones.
- **Colores del logo.** UV planares en todas las caras. La textura de color sustituye el borde (mezclado con el fondo) por el color sólido más cercano, de modo que el bisel y los laterales no muestran halos.
- **Vídeo determinista.** Cada frame se renderiza en un instante exacto (`i / fps`) y se codifica con WebCodecs. No se pierden frames aunque el equipo sea lento.
- **Bucle perfecto.** La velocidad se ajusta para que quepa un número entero de ciclos en la duración elegida. La cámara y las partículas también son periódicas en esa duración.
- **La interfaz nunca se congela.** El trazado y la textura van en un Web Worker. Las imágenes de más de 100 MP se rechazan antes de decodificarse, y las que pasan de 4096 px se decodifican ya reducidas.
- **Memoria plana al exportar.** En la app de escritorio el vídeo o el ZIP se escribe en el archivo mientras se codifica, no en memoria. Los trozos pasan por un búfer compartido con el host (`PostSharedBufferToScript`), sin base64: más de 1 GB/s, necesario para el AVI sin compresión (~8 MB por fotograma en 1080p).
- **AVI de más de 2 GB.** El AVI se escribe como OpenDML (AVI 2.0): segmentos RIFF de hasta 1 GB con índices `ix00` y un superíndice `indx`, más un `idx1` clásico en el primero para lectores antiguos.
- **WebM con transparencia sin soporte nativo.** WebCodecs no codifica alfa en Edge, así que se codifican dos flujos VP9 (color y alfa como luma) y el alfa se guarda como `BlockAdditional`, igual que hace Chrome por dentro. Requiere un parche de una línea en `vendor/webm-muxer`, comentado en el código.

## Desarrollo

Requisitos: .NET SDK 10 y WebView2 Runtime (preinstalado en Windows 11).

```bash
dotnet run --project src/ImageTo3D
```

Para depurar el motor en un navegador normal con DevTools:

```bash
powershell -ExecutionPolicy Bypass -File tools/serve.ps1 -Port 5188
```

En las compilaciones Debug de la app también se puede pulsar F12 dentro de la ventana.

## Instalador

Doble clic en `Crear instalador.bat` o, desde una terminal:

```bash
powershell -ExecutionPolicy Bypass -File Compilar-ImageTo3D.ps1
```

Requisitos: SDK de .NET 10 e [Inno Setup 6](https://jrsoftware.org/isinfo.php). Inno Setup se instala sin permisos de administrador con:

```bash
winget install --id JRSoftware.InnoSetup -e --scope user
```

El script publica la app **autocontenida** (lleva .NET dentro, no hace falta instalar nada más) en `build/publish` y genera `build/installer/ImageTo3D-Setup-<versión>.exe` (~43 MB). La versión sale de `<Version>` en [ImageTo3D.csproj](src/ImageTo3D/ImageTo3D.csproj).

Qué hace el instalador ([installer/ImageTo3D.iss](installer/ImageTo3D.iss)):
- Asistente en español o inglés. Instala por usuario sin pedir administrador, aunque se puede elegir "para todos los usuarios".
- Crea un acceso en el menú Inicio, opcionalmente otro en el escritorio, y abre la app al terminar.
- Avisa si falta WebView2 Runtime, que viene con Windows 11 y Windows 10 actualizado.
- Asocia los archivos `.i3d`: un doble clic abre el proyecto en ImageTo3D.
- Las actualizaciones se instalan encima (mismo `AppId`), cierran la app si está abierta y conservan los recientes.
- El desinstalador también borra `%LOCALAPPDATA%\ImageTo3D`: la caché, los ajustes y la lista de recientes. Los `.i3d` guardados por el usuario no se tocan.

`-SinInstalador` solo publica. El icono se regenera con `tools/make-icon.ps1`.

## Licencias de terceros

- three.js r186: MIT ([wwwroot/vendor/three/LICENSE](src/ImageTo3D/wwwroot/vendor/three/LICENSE))
- mp4-muxer 5.2.2: MIT
- webm-muxer 5.1.4: MIT (con un parche de una línea para el alfa, comentado)
- Microsoft.Web.WebView2: licencia de Microsoft
