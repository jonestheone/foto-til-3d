# Foto til 3D

**Prøv den her (også på mobilen): https://jonestheone.github.io/foto-til-3d/**

En app, der laver et foto om til en 3D-model – direkte i browseren.
Tag et billede (eller vælg et), og appen

1. **finder motivet** og fjerner baggrunden (AI-modellen *RMBG-1.4*),
2. **gætter dybden** i billedet (AI-modellen *Depth Anything V2*),
3. **bygger en 3D-model**, som du kan dreje rundt og downloade som **GLB** (med farver) eller **STL** (til 3D-print).

Formerne **Figur** og **Relief** laves helt på din egen enhed – billedet sendes ingen steder hen.
Formen **360° AI** laver en rigtig model hele vejen rundt (med bagside) ved hjælp af en gratis AI
hos Hugging Face – her sendes fotoet (uden baggrund) dertil.

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
- **360° AI**: en rigtig 3D-model hele vejen rundt, også bagsiden (se nedenfor). Tryk **Lav 360°-model**.
  Står appen på 360° AI, laves modellen automatisk for hvert nyt billede.
- **Ekstra skarp dybde**: AI'en ser billedet i højere opløsning (1022 i stedet for 518 px), så øjne, hår
  og folder bliver tydeligere. Det tager længere tid og er derfor kun slået til, når der er et grafikkort.
- **Dybde / Tykkelse**: hvor meget modellen stikker frem, og hvor tyk den er.
- **Afrunding**: hvor runde kanterne er. I en figur bliver kanten, hvor for- og bagside mødes, rund
  i stedet for knivskarp. I et relief får pladen en afrundet øverste kant. 0 % = skarpe kanter.
- **Fremhæv detaljer**: forstærker de små former (næse, øjne, pels, folder). 0 % = som AI'en så det.
- **Glathed**: glatter små ujævnheder ud. Lavt tal = flere detaljer, men også mere "støj".
- **Opløsning**: hvor mange punkter 3D-nettet har (op til 768). Flere punkter = finere detaljer, men større filer.
- **Download GLB**: kan åbnes i Windows' *3D Viewer*, Blender, PowerPoint, Sketchfab m.m.
- **Download STL**: til 3D-printere (Cura, PrusaSlicer, Bambu Studio). Den længste side er 100 mm.

**Gode billeder**: ét tydeligt motiv, god belysning, rolig baggrund, og hele motivet med i billedet.

## 360° med AI (rigtig bagside)

Ét foto viser kun den ene side af motivet. I **360° AI** sender appen et udklip af motivet (uden
baggrund) til en gratis AI-demo på [Hugging Face](https://huggingface.co), som laver en hel 3D-model
og sender den tilbage. Bagsiden er AI'ens bedste gæt – den har jo ikke set den.

| Valg | AI | Tid | Login |
|---|---|---|---|
| **Hurtig** (standard) | *Stable Fast 3D* fra Stability AI | ca. 10 sek. | Ikke nødvendigt |
| **Bedst** | *TRELLIS* fra Microsoft | ca. 1–2 min. | Kræver en gratis Hugging Face-nøgle |

- AI'erne kører på Hugging Face's gratis grafikkort, som har en **daglig kvote**. Uden login rækker den
  til en del modeller med "Hurtig" om dagen. Er kvoten brugt, siger appen det.
- **Hugging Face-nøgle** (valgfri): lav en gratis konto, og opret en nøgle ("Read") på
  https://huggingface.co/settings/tokens. Sæt den ind under *Hugging Face-nøgle* i appen. Så får du mere
  kvote, og "Bedst" virker. Nøglen gemmes kun i browseren på din egen enhed.
- Virker "Bedst" ikke (fx uden nøgle), bruger appen automatisk "Hurtig" i stedet.
- AI'erne vender modellen forskelligt, så appen drejer den selv, så fotoets side vender frem
  (den sammenligner modellens omrids fra 4 sider med motivets omrids på fotoet).
- **Download GLB** gemmer AI'ens model, som den er. **Download STL** stiller modellen op på printpladen.

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
| `js/ai3d.js` | "360° AI": sender udklippet til AI'en på Hugging Face og henter modellen hjem |
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
   Omridset sløres en smule, så det ikke bliver takket, og kanten rundes af med
   *Taubin-udglatning* (punkterne trækkes mod naboerne og lidt tilbage igen, så intet skrumper).
4. Fotoet (op til 2048 px) bruges som "maling" (tekstur) på modellen. AI'en arbejder selv med 1024 px.

## Begrænsninger

- I **Figur** og **Relief** ser appen kun motivet fra én side, så bagsiden er en afrundet, spejlet
  udgave af forsiden. Det ligner en rigtig 3D-model forfra og fra siden, men ikke bagfra.
- **360° AI** laver en rigtig bagside, men den er AI'ens gæt, kræver internet, og den gratis kvote
  hos Hugging Face er begrænset. AI-demoerne kan også være optaget eller ændre sig – så siger appen det.

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
- Gradio-klienten (forbindelsen til Hugging Face): Apache-2.0
- 360° AI: *Stable Fast 3D* bruger Stability AI's "Community License" (gratis til privat brug og små
  virksomheder), *TRELLIS* er MIT. Begge kører på Hugging Face's gratis demo-sider.
- **RMBG-1.4** (baggrundsfjernelse): BRIAs licens. **Kun til ikke-kommerciel brug.**
  Skal appen bruges kommercielt, kan den udskiftes med fx `onnx-community/BiRefNet_lite-ONNX` (MIT).
  Det kræver en lille ændring af `background`-delen i `js/ai-worker.js`, så den bruger
  `pipeline('background-removal', ...)` i stedet.
