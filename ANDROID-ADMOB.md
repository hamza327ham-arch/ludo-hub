# AdMob + Android app: step by step (Roman Urdu)

## Pehle ye samajh lo
- **AdMob sirf mobile app (Android/iOS) mein chalta hai.** Seedhi website ya `index.html` mein AdMob nahi chalta.
- Isi liye game ko ek Android app ke andar pack karte hain (Capacitor se). Folder `android-app/` is ke liye tayyar hai.
- Website par ads chahiye hon to wo alag product hai (Google AdSense). Abhi hum sirf AdMob ka rasta bana rahe hain.
- Game ke andar ads ka code pehle se hai (`index.html` mein `ADS_CONFIG`). Test mode mein nakli ads dikhte hain, taake aap flow dekh sakein.

## AdMob se aap ko kya chahiye (sirf 4 cheezein)
1. **App ID**: dikhta hai aise `ca-app-pub-1234567890123456~1234567890` (beech mein `~`).
2. **Banner ad unit ID**: `ca-app-pub-1234567890123456/1111111111` (beech mein `/`).
3. **Interstitial ad unit ID** (do games ke beech wala).
4. **Rewarded ad unit ID** ("video dekho, coins lo" wala).

### Ye kaise banate hain
1. admob.google.com par Google account se sign in karo, shartein manzoor karo.
2. **Apps -> Add app -> Android**. "Is the app published?" par abhi **No** chuno, naam likho ("Ludo Hub"). Apna **App ID** copy karo.
3. Us app ke andar **Ad units -> Add ad unit** se teen unit banao: Banner, Interstitial, Rewarded. Teeno ke IDs copy karo.
4. Payments ke liye: **Payments** tab mein payee ka naam aur address sahi bharo (cheque/PIN isi address par aata hai).

## Konsi file mein kya lagana hai
| Cheez | Kahan | Kya likhna hai |
|---|---|---|
| Banner, Interstitial, Rewarded IDs | `index.html` ke script ke shuru mein `ADS_CONFIG` | `mode:"admob"`, teeno ids paste karo, `isTesting:false` (live karte waqt) |
| **App ID** | Android project ki `android/app/src/main/AndroidManifest.xml`, `<application>` ke andar | `<meta-data android:name="com.google.android.gms.ads.APPLICATION_ID" android:value="ca-app-pub-...~..."/>` |
| Server ka address | `index.html` mein `APP_CONFIG` | `serverUrl:"wss://aap-ka-domain.com"`, `publicUrl:"https://aap-ka-domain.com"` |
| App ko server se jorne ki ijazat | server chalate waqt environment | `ALLOWED_ORIGINS=https://localhost,capacitor://localhost` |

`ADS_CONFIG.mode` ke teen option: `"off"` (koi ad nahi), `"test"` (nakli ads, default), `"admob"` (asli AdMob, sirf app ke andar).

## Android app banane ke qadam
Computer par chahiye: Node.js, Android Studio. Phir `android-app/` folder mein:
```
npm install
npm run copy-web          # index.html ko www/ mein copy karta hai
npx cap add android       # android/ folder banata hai
```
Phir `android/app/src/main/AndroidManifest.xml` kholo aur upar wali `<meta-data ...APPLICATION_ID...>` line `<application>` ke andar lagao.
```
npm run sync
npm run open              # Android Studio khulta hai, phone USB se jor kar Run dabao
```
`capacitor.config.json` mein `appId` ko apne naam wala (jaise `com.ludohub.app`) kar do. Ye Play Store par hamesha ke liye us app ki pehchan banti hai.

## Pehle TEST ads se chalao
`ADS_CONFIG` mein Google ke test IDs pehle se likhe hain (`ca-app-pub-3940256099942544/...`). Pehle inhi se app chala kar dekho: banner neeche aaye, video dekh kar coins milein, do games ke beech interstitial aaye. Phir apne asli IDs lagao.

**Apne asli ads par kabhi click mat karo, na doston se karwao.** Isse AdMob account band ho sakta hai. Development mein hamesha test IDs.

## Google Play par daalna
- Play Console developer account chahiye (ek baar ki fees lagti hai, rate Google ki site par dekh lo).
- App publish hone ke baad AdMob mein app ko Play Store listing se **link** karo.
- Privacy policy ka page chahiye (app kya data leta hai aur ads Google dikhata hai). Age rating sahi rakho: Ludo mein bacche bhi aate hain, aur bacchon ke liye ads ke sakht qawaid hain (non-personalized ads, restricted categories).
- Europe/UK ke users hon to AdMob ka consent form (UMP) lagana padta hai.
- iOS app ke liye Mac aur Apple developer account chahiye.


## Game mein ads kahan kahan aate hain (abhi)
| Jagah | Ad ki qisam | Kab |
|---|---|---|
| Home screen aur lobby ke bilkul neeche | Banner | Hamesha (jab ads on hon) |
| Home par "🎬 Watch ad" button, aur Profile mein | Rewarded video | Player khud chune: +300 coins (roz 8 tak, do ads ke beech 3 minute) |
| Game khatam hone ke baad, Menu ya Play again dabane par | Interstitial | Har 3rd game par (`interstitialEveryNGames`) |
| Game ke dauran (board par) | **Koi ad nahi** | Galti se click se bachne aur player ko tang na karne ke liye |

Test mode (`mode:"test"`) mein ye teeno nakli ads ki shakal mein dikhte hain, taake aap flow dekh sakein.

## (Purani baat) Pehle screenshot ke IDs
Is section ke IDs purane doosre app ke the. Ab `index.html` mein Ludo Hub ke apne naye IDs lag chuke hain, aur App ID `ca-app-pub-3697668089255708~9068063502` Android build mein khud lag jata hai (GitHub variable zaroori nahi).

## Purana note
Screenshot mein 3 ad units hain: `hint_heart_rewarded` (Rewarded), `home_banner` (Banner), `level_interstitial` (Interstitial). Inke naam (hint, heart, level) se lagta hai ke ye kisi **doosre game ke** hain.
- Maine inhi 3 IDs ko `ADS_CONFIG` mein rakh diya hai, lekin `isTesting:true` aur `mode:"test"` ke saath, to abhi koi asli ad nahi dikhta.
- **Behtar ye hai:** AdMob mein **naya app "Ludo Hub"** banao aur uske apne 3 units banao, phir unke IDs `ADS_CONFIG` mein badal do. Ek app ke ad unit ko doosre app mein chalane se AdMob "invalid traffic" ya mismatch ki shikayat kar sakta hai aur kamai ruk sakti hai.
- Naye app ka **App ID** (`ca-app-pub-3697668089255708~xxxxxxxxxx`, beech mein `~`) bhi chahiye: AdMob mein Apps -> App settings. Ye ID ad unit IDs se alag hoti hai aur sirf Android manifest mein jati hai (GitHub wale tareeqe mein `ADMOB_APP_ID` variable mein).
- Teen stage: (1) `mode:"test"` nakli ads, (2) `mode:"admob"` + `isTesting:true` Google ke test ads app ke andar, (3) `mode:"admob"` + `isTesting:false` asli ads, sirf final release par.

## GitHub se app banwana
Folder mein `.github/workflows/android.yml` pehle se hai. Ye GitHub ke server par APK bana deta hai, aap ko Android Studio install nahi karna.
1. github.com par account banao, **New repository** -> naam `ludo-hub` -> **Private** rakho -> Create.
2. "uploading an existing file" par click karo aur folder ki saari files (`.github` folder samet) drag karke daal do, branch `main`, **Commit**. (Agar `.github` folder upload mein na aaye to GitHub Desktop istemal karo.)
3. (Naya App ID mil jaye to) Repo ki **Settings -> Secrets and variables -> Actions -> Variables -> New repository variable**: naam `ADMOB_APP_ID`, value aap ka App ID.
4. **Actions** tab -> "Build Android app (Ludo Hub)" -> **Run workflow**. 5-10 minute lagte hain.
5. Khatam hone par us run ke page se **LudoHub-debug-apk** download karo, unzip karo, `.apk` phone mein install karo (phone mein "unknown sources" ki ijazat deni hogi).
Ye debug build hai, sirf testing ke liye. Play Store ke liye signed bundle chahiye (key store banana padta hai), wo agla qadam hai.

Dhyan rakhein: ye GitHub wali build maine yahan chala kar nahi dekhi (mere paas Android SDK aur GitHub ka rasta nahi). Workflow ki file aur manifest wali script ki jaanch ho chuki hai, lekin pehli baar chalane par koi error aa sakta hai. Error ka text mujhe bhej dein.

Aur app online tab hi khelegi jab server internet par ho. Bina server ke app ke andar computer ke saath wali game chalti hai.

## Paisa kaise aata hai
- Earnings = (ads dikhne ki tadad / 1000) x eCPM. eCPM wo rakam hai jo 1000 ad views par milti hai. Ye mulk, ad ki qisam (rewarded aksar zyada), season aur users par depend karti hai. Pehle se koi pakki raqam nahi di ja sakti.
- Sirf samajhne ki misaal: agar eCPM $2 ho aur roz 10,000 ad views hon, to roz taqreeban $20. Asal eCPM AdMob ke Reports mein dikhta hai.
- Payment ke qawaid (Google AdMob help se): har mahine ke aas paas 21 tareekh ko payment banti hai, shart ye hai ke balance **$100** tak pahunch jaye warna agle mahine mein jama hota rehta hai. **$10** ki earnings par Google aap ke address par PIN bhejta hai, jo AdMob mein daalna zaroori hai. Payment ka tareeqa aap ke address ke hisaab se AdMob ke Payments page par dikhta hai (wire, EFT, cheque, wagera). PayPal ab nahi hai. Apne mulk mein kaun sa tareeqa milta hai wo AdMob mein account bana kar pakka dekho.
- Shuru mein kamai bohat kam hoti hai. Asli kamai roz hazaron active players se aati hai.

## Rewarded ads se coins: cheating se bachao
Server pehle se ye karta hai: ad shuru karte waqt server ek nonce deta hai, kam az kam 15 second guzarne ke baad hi reward deta hai, ek nonce sirf ek baar chalta hai, do rewards ke beech 3 minute ka gap hai, aur roz 8 se zyada nahi. Production mein AdMob ka **Server-Side Verification (SSV)** bhi lagana behtar hai: AdMob khud aap ke server ko batata hai ke ad poora dekha gaya.

## Kya maine test kiya, kya nahi
- Test hua: ads ka layer test mode mein (nakli ad, 15 second wala countdown ke baghair 2 second par chalaya gaya), server ke reward ke qawaid, coins, accounts.
- **Test NAHI hua:** asli AdMob plugin, Android Studio mein build, Google ke test ads. Ye code `@capacitor-community/admob` plugin ke documented functions par likha hai, lekin maine ise asli phone par nahi chalaya. Pehli baar chalane par plugin ke naam ya events mein farq nikal sakta hai; mujhe error bhej dena.
