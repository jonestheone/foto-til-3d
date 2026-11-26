# Foto til 3D

**Prøv den her (også på mobilen): https://jonestheone.github.io/foto-til-3d/**

En app, der laver et foto om til en 3D-model – direkte i browseren.
Tag et billede (eller vælg et), og appen

1. **finder motivet** og fjerner baggrunden (AI-modellen *RMBG-1.4*),
2. **gætter dybden** i billedet (AI-modellen *Depth Anything V2*),
3. **bygger en 3D-model**, som du kan dreje rundt og downloade som **GLB** (med farver) eller **STL** (til 3D-print).

Alt kører på din egen computer. Billedet bliver ikke sendt nogen steder hen.

## Sådan starter du appen

1. Dobbeltklik på **`start.cmd`**.
2. Et sort vindue åbner (det er den lille webserver), og appen åbner i din browser på `http://localhost:8080`.
3. Luk det sorte vindue, når du er færdig.

Der skal **ikke installeres noget**. Du skal bare have internet første gang, fordi AI-modellerne
(ca. 130 MB med grafikkort, 70 MB uden) hentes fra Hugging Face. Derefter gemmer browseren dem.

> Brug Chrome eller Edge. De kan bruge grafikkortet (WebGPU), og så går det meget hurtigere.

## Sådan bruger du den

- **Tag billede**: bruger webcam på computeren (på en mobil åbner kamera-appen).
- **Vælg billede**: vælg en fil. Du kan også trække et billede ind i vinduet eller indsætte med `Ctrl+V`.
- **Figur**: motivet "pustes op" og får en afrundet bagside. Godt til ting, dyr og personer.
- **Relief**: billedet bliver til en plade med relief og flad bagside. Godt til 3D-print.
- **Ekstra skarp dybde**: AI'en ser billedet i højere opløsning (1022 i stedet for 518 px), så øjne, hår
  og folder bliver tydeligere. Det tager længere tid og er derfor kun slået til, når der er et grafikkort.
- **Dybde / Tykkelse**: hvor meget modellen stikker frem, og hvor tyk den er.
- **Fremhæv detaljer**: forstærker de små former (næse, øjne, pels, folder). 0 % = som AI'en så det.
- **Glathed**: glatter små ujævnheder ud. Lavt tal = flere detaljer, men også mere "støj".
- **Opløsning**: hvor mange punkter 3D-nettet har (op til 768). Flere punkter = finere detaljer, men større filer.
- **Download GLB**: kan åbnes i Windows' *3D Viewer*, Blender, PowerPoint, Sketchfab m.m.
- **Download STL**: til 3D-printere (Cura, PrusaSlicer, Bambu Studio). Den længste side er 100 mm.

**Gode billeder**: ét tydeligt motiv, god belysning, rolig baggrund, og hele motivet med i billedet.

## Sådan virker det (for de nysgerrige)

| Fil | Hvad den gør |
|---|---|
| `index.html` | Siden: knapper, panel og 3D-felt |
| `css/style.css` | Udseendet |
| `js/main.js` | Appens "hjerne": styrer knapper, billeder og hvornår modellen bygges |
| `js/ai-worker.js` | Kører AI-modellerne i baggrunden med [Transformers.js](https://huggingface.co/docs/transformers.js) |
| `js/mesh.js` | Laver selve 3D-formen ud fra dybdekortet og masken |
| `js/viewer.js` | Viser modellen med [Three.js](https://threejs.org) |
| `js/export.js` | Gemmer som GLB og STL |
| `js/camera.js` | Webcam-vinduet |
| `sw.js` | "Service worker": gør appen installerbar og brugbar uden internet |
| `manifest.webmanifest` + `icons/` | Appens navn og ikoner på telefonens hjemmeskærm |
| `server.ps1` + `start.cmd` | En lille lokal webserver (browsere kræver en server for at køre appen) |

Kort fortalt om 3D-formen (`mesh.js`):

1. Et gitter på fx 384 × 307 punkter lægges over billedet.
2. Hvert punkt får en højde fra dybdekortet (tæt på kameraet = højt) – gennemsnittet af alle
   pixels i sin celle. Ude ved motivets kant glider dybden over i en udglattet udgave, fordi
   AI'ens dybde er upålidelig lige ved kanten. "Fremhæv detaljer" forstærker forskellen mellem
   dybden og en udglattet udgave af den (en såkaldt *unsharp mask*).
3. I **Figur**-tilstand løses en *Poisson-ligning* inde i motivet. Det giver en blød "ballon-form",
   hvor tynde dele (arme, ører, haler) bliver tynde og tykke dele bliver tykke.
   For- og bagsiden mødes i kanten, så modellen er lukket ("vandtæt") og kan 3D-printes.
4. Fotoet (op til 2048 px) bruges som "maling" (tekstur) på modellen. AI'en arbejder selv med 1024 px.

## Begrænsninger

Appen ser kun motivet fra én side, så **bagsiden er gættet**. Den er en afrundet, spejlet udgave
af forsiden. Det ligner en rigtig 3D-model forfra og fra siden, men ikke bagfra.

Rigtige 360°-modeller fra ét billede kræver store AI-modeller (fx TRELLIS, Hunyuan3D, Tripo eller Meshy),
som kører på kraftige grafikkort i skyen. Det kan tilføjes som en ekstra knap, men det kræver en
API-nøgle og koster typisk lidt pr. model.

## Brug på mobilen

Appen ligger på **https://jonestheone.github.io/foto-til-3d/** (GitHub Pages).

1. Åbn adressen på telefonen – i **Chrome** på Android eller **Safari** på iPhone.
2. Læg den på hjemmeskærmen, så den åbner som en rigtig app:
   - **Android**: tryk på **Installér som app** (eller menuen ⋮ → *Installer app*).
   - **iPhone**: tryk på **Del**-knappen og vælg **Føj til hjemmeskærm**.
3. **Tag billede** åbner telefonens kamera.

Første gang hentes AI-modellerne (ca. 130 MB), så brug gerne Wi-Fi. Derefter husker telefonen
både appen og modellerne, og så virker den også uden internet.

Nyere telefoner har WebGPU (Chrome på Android 12+, iPhone med iOS 26) og bruger grafikkortet. Med
"Ekstra skarp dybde" tager et billede typisk 10–20 sekunder – slå den fra, hvis det skal gå hurtigere.
Ældre telefoner bruger processoren i stedet, og så kan det tage op til et minut.

### Opdatér appen online

Når du har ændret noget, sender du ændringerne til GitHub. Så er den nye udgave online efter ca. et minut:

```powershell
git add -A
git commit -m "Beskriv hvad du har ændret"
git push
```

## Licenser

- Transformers.js og Depth Anything V2 Small: Apache-2.0
- Three.js: MIT
- **RMBG-1.4** (baggrundsfjernelse): BRIAs licens. **Kun til ikke-kommerciel brug.**
  Skal appen bruges kommercielt, kan den udskiftes med fx `onnx-community/BiRefNet_lite-ONNX` (MIT).
  Det kræver en lille ændring af `background`-delen i `js/ai-worker.js`, så den bruger
  `pipeline('background-removal', ...)` i stedet.
