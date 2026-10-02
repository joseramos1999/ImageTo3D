# ImageTo3D

App de escritorio para Windows que convierte un PNG (o JPG, WEBP, SVG o un texto) en un logo 3D extruido, permite darle material, iluminación y animación, y lo exporta como vídeo MP4, imagen PNG o modelo GLB/STL.

Funciona sin conexión: todo se renderiza en local, con la GPU.

## Arquitectura

```
ImageTo3D.exe (WPF, .NET 10)
 └─ WebView2 (Chromium de Edge, viene con Windows 11)
     └─ https://app.imageto3d/  →  carpeta wwwroot/ (host virtual, sin servidor)
         ├─ js/trace.js       PNG → campo de "tinta" → marching squares interpolado → contornos + agujeros
         ├─ js/geometry.js    contornos → ExtrudeGeometry con bisel, UV planares, textura de color (erosión + push-pull)
         ├─ js/materials.js   24 materiales (colores del logo, oro, cromo, cristal, diamante, neón, holo…)
         ├─ js/animations.js  32 animaciones (21 bucles + 10 intros + estático), funciones puras del tiempo
         ├─ js/stage.js       render, luces, suelos (sombra, espejo, rejilla, foco), fondos, bloom, partículas, cámara
         ├─ js/exporter.js    MP4 (WebCodecs H.264 + mp4-muxer), PNG, GLB, STL
         └─ js/app.js         interfaz ↔ motor
```

El host en C# ([MainWindow.xaml.cs](src/ImageTo3D/MainWindow.xaml.cs)) intercepta las descargas del motor y muestra el diálogo nativo "Guardar como". Después avisa al motor para que ofrezca "Mostrar en carpeta".

### Decisiones clave

- **Trazado con precisión de subpíxel.** La máscara no se umbraliza: marching squares interpola sobre el canal alfa (o sobre la distancia de color al fondo en imágenes opacas). Así un logo con antialiasing da contornos suaves sin escalones.
- **Colores del logo.** UV planares en todas las caras. La textura de color sustituye el borde (mezclado con el fondo) por el color sólido más cercano, de modo que el bisel y los laterales no muestran halos.
- **Vídeo determinista.** Cada frame se renderiza en un instante exacto (`i / fps`) y se codifica con WebCodecs. No se pierden frames aunque el equipo sea lento.
- **Bucle perfecto.** La velocidad se ajusta para que quepa un número entero de ciclos en la duración elegida. La cámara y las partículas también son periódicas en esa duración.

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
- Las actualizaciones se instalan encima (mismo `AppId`) y cierran la app si está abierta.
- El desinstalador también borra la caché y los ajustes de `%LOCALAPPDATA%\ImageTo3D`.

`-SinInstalador` solo publica. El icono se regenera con `tools/make-icon.ps1`.

## Licencias de terceros

- three.js r186: MIT ([wwwroot/vendor/three/LICENSE](src/ImageTo3D/wwwroot/vendor/three/LICENSE))
- mp4-muxer 5.2.2: MIT
- Microsoft.Web.WebView2: licencia de Microsoft
