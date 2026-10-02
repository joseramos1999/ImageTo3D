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

## Publicar

```bash
dotnet publish src/ImageTo3D/ImageTo3D.csproj -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -o dist
```

Resultado: `dist/` (~5 MB). Requiere tener instalado el .NET 10 Desktop Runtime. Con `--self-contained true` no hace falta, pero ocupa ~70 MB.

## Licencias de terceros

- three.js r186: MIT ([wwwroot/vendor/three/LICENSE](src/ImageTo3D/wwwroot/vendor/three/LICENSE))
- mp4-muxer 5.2.2: MIT
- Microsoft.Web.WebView2: licencia de Microsoft
