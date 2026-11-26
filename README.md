# Springklip

Forsinket live-billede til springtræning, med automatisk springgenkendelse og klip pr. gymnast.

- **Live**: iPad'en står på stativ og viser træningen med en forsinkelse, man selv vælger. Man kan spole 5 sekunder frem og tilbage og sætte på pause.
- **Springgenkendelse**: Siden ser efter bevægelse i et "luftfelt" over trampetten, som man markerer én gang.
- **Nummerskilte**: Efter landingen læser siden gymnastens nummerskilt (ArUco 4x4, se `skilte/`), og klippet gemmes under det nummer.
- **Klip**: Træneren ser alle klip og retter dem, der mangler et nummer. Gymnasten ser kun sine egne under "Mine spring" med sin personlige kode.

Det forsinkede live-billede gemmes ikke; det ligger kun kortvarigt i hukommelsen på iPad'en. Klippene af springene gemmes på den enhed, der optager (IndexedDB), og når en træner er logget ind, sendes de også til skyen (Supabase). Der kan trænerne se alle klip, hver gymnast ser sine egne med sin personlige kode, og holdomgange kan hele holdet se. Klippene slettes automatisk efter 10 dage (kan ændres under Opsætning).

Nummerlæsningen bruger [js-aruco2](https://github.com/damianofalcioni/js-aruco2) (MIT, se `lib/LICENSE-js-aruco2.txt`).
