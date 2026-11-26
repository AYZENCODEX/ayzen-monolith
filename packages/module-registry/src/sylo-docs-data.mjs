/**
 * sylo-docs-data.mjs: the SYLO / AYZEN ecosystem notes, line for line, as chapters > topics > subtopics.
 * Source: the author's SYLO / AYZEN notes (Utility and Use-Cases chapters of the PDF; tokenomics, governance and business-model are not published). `lines` are the note text exactly as written
 * (Bengali and English mixed); do not reword them. Render with sylo-docs.mjs. Subtopics 1.1.1 and 3.1.1 are the two overview diagrams
 * of the PDF written out as text.
 */
export const SYLO_DOCS = [
 {
  "n": 1,
  "slug": "utility",
  "title": "UTILITY",
  "desc": "SYLO এর ফিচার, সিকিউরিটি ও কানেক্টেড মডিউল",
  "topics": [
   {
    "n": "1.1",
    "slug": "ecosystem-overview",
    "title": "Ecosystem Overview",
    "subs": [
     {
      "n": "1.1.1",
      "title": "Ecosystem Overview",
      "lines": [
       "SYLO — ACCESS · ENTITY · ENROLL",
       "AXTA — EXTENSION",
       "ZYNTH AI — MCP AGENT",
       "SKARN — TRACKING",
       "VERVE — SELL · ESCROW",
       "AYZEN — OIDC PROVIDER",
       "AZN — CURRENCY",
       "AGT — GOVERNANCE TOKEN",
       "AGRT — VOTE POWER"
      ]
     }
    ]
   },
   {
    "n": "1.2",
    "slug": "sylo-core-and-access",
    "title": "SYLO Core & Access",
    "subs": [
     {
      "n": "1.2.1",
      "title": "What is SYLO",
      "lines": [
       "☐ SYLO হলো একটি WEB APP (with vibe of AI)। A Perfect mix of mailbox, 2FA auth, Credential keeper like Password Manager, Bitkeep এর মত। SYLO শুধু Astra এর extension ব্যবহার করে যা AUTOMATIC ACCOUNT VERIFY করে LOGIN করে দেয়।",
       "  [ডায়াগ্রাম]",
       "  \"ENTITY\" → \"ACCESS\" ← \"ENROLL\"",
       "  \"LOCAL\"  \"EXCHANGE\"",
       "  \"ASTRA\" ←— \"BACKUP\" ←— \"DYNAMIC AI\"",
       "☐ SYLO এর মাধ্যমে 50-100+ ACCOUNT MANAGE করা যায়। এখানে যেকোনো ACCOUNT সহজে লগইন করতে যা লাগে তা STORE করে বা SAVE করা যায়। শুধু MOBILE এ EMAIL লগইন না করে APP থেকে EMAIL এর CODE নিয়ে লগইন করা যায়। আবার 2STEP ভেরিফিকেশন (2FA AUTH ON থাকলে) তা STORE করলে APP থেকে তাও নিয়ে VERIFY করা যায়। সব GROUPED থাকে \"ACCESS\" FEATURE এর ভেতর।"
      ]
     },
     {
      "n": "1.2.2",
      "title": "Access Feature",
      "lines": [
       "\"ACCESS\"",
       "☐ ACCESS FEATURE এর মাধ্যমে আমরা সবকিছুই GROUPED MAILBOX, 2FA, BACKUP CODE এর সেকশনে পাচ্ছি। Like ⇒",
       "  ACCESS",
       "  MAILBOX → এই ACC এ যে CODE আসে তা দেখা যায়, MAIL লগইন করা লাগে না।",
       "  2FA → Google Auth এ code গুলো flat থাকে, অনেক ঝামেলা ও খোঁজা লাগে।",
       "  BACKUP CODE → RECOVERY হিসাব অনেক ACC এ BACKUP CODE GENERATE করা হয়; PASS, 2FA, EMAIL কাজ না করলে ব্যবহার করতে হয়।",
       "☐ এই FEATURE দিয়ে সহজেই 100+ ACC MANAGE করা যায়, এটি BITKEEP, PASSWORD MANAGER এর UPGRADE VERSION WITH AI INTEGRATION, এবং বাকি সব কাজ সহজ করার জন্য।"
      ]
     },
     {
      "n": "1.2.3",
      "title": "Access Workflow",
      "lines": [
       "☐ ACCESS FEATURE কিভাবে USE করবো? FLOW এমন, উদাহরণ:",
       "  TWITTER ACC এ লগইন করবো, APP এর WORKFLOW : আমি ACCOUNT CLICK করলাম, EMAIL PASS COPY করলাম, THEN PASTE করলাম, ACCESS এ CLICK করলাম, MAIL SLIDE ACCESS PAGE এ গেলাম, 2FA থাকলে SLIDE 2FA এর CODE COLLECT করলাম, SUBMIT করলাম, ACCOUNT LOGIN হয়ে গেল।",
       "  যদি PASSWORD ভুল হয়, EMAIL CODE ও কাজ না করে, SECURITY ISSUE THEN ACCESS PAGE 2FA SIDE থেকে COPY করে PASTE করলে PROBLEM SOLVED।",
       "  [FLOW ডায়াগ্রাম]",
       "  [TWITTER] → [APP থেকে EMAIL PASS COPY] → [TWITTER এ PASTE]",
       "          → [APP এ ACCESS থেকে CODE] → [TWITTER PASTE]",
       "          → [TWITTER LOGIN DONE] → TASK DONE"
      ]
     }
    ]
   },
   {
    "n": "1.3",
    "slug": "entity-system",
    "title": "Entity System",
    "subs": [
     {
      "n": "1.3.1",
      "title": "Target Users",
      "lines": [
       "☐ SYLO MULTIPLE ACCOUNT নিয়ে AIRDROP FARMING ও ACCOUNT FARMING এর জন্য BUILD করা। POWER USER দের জন্য যারা 100+ ACC বা MINIMUM 40-50 ACCOUNT নিয়ে AIRDROP করে।",
       "  [ডায়াগ্রাম]",
       "  SYLO → \"যারা 100+ ACCOUNT MANAGE করে কাজ করে\" ← POWER USER",
       "  SYLO → \"WEB3 USER — যারা 50-60 ACCOUNT নিয়ে কাজ করে\"",
       "☐ SYLO ENTITY FEATURE WEB3 USER দের প্রতিনিধিত্ব করছে, LOCAL ACCOUNT POWER USER দের জন্য BUILD করা। ENTITY FEATURE দিয়ে GROUPED SOCIAL ACCOUNT পরিচালনা সহজ হয়।"
      ]
     },
     {
      "n": "1.3.2",
      "title": "Entity Structure",
      "lines": [
       "ENTITY",
       "  TELEGRAM  TWITTER  DISCORD  EMAIL  GITHUB  WALLET",
       "  একটা ENTITY CREATE বা BUILD হয় TELEGRAM, TWITTER, DISCORD, EMAIL, GITHUB, WALLET নিয়ে। কারণ একটা PROJECT এর AIRDROP করতে গেলে:",
       "  [ TELEGRAM CHANNEL JOIN",
       "  [ TWITTER FOLLOW, REPOST, LIKE      | MANDATORY",
       "  [ DISCORD CHANNEL JOIN              | AIRDROP",
       "  [ EMAIL VERIFY                      | TASKS",
       "  [ ACCOUNT CREATE",
       "  [ WALLET CONNECT"
      ]
     },
     {
      "n": "1.3.3",
      "title": "Entity per Project",
      "lines": [
       "ACCOUNT খোলার দরকার খুললো, 10 টা ENTITY বানালো, 10 টা ACCOUNT এর জন্য TASK COMPLETE করলো। এখন FACT হলো SYLO ENTITY DEFAULT বা UNIQUE, যে PROJECT ACCOUNT গুলো খোলা হয়, তা ENROLLED ACCOUNT দিয়ে STORE হয়।",
       "☐ একজন ২০টা SYLO ENTITY বানালো, সে EASILY 10-12 টা PROJECT এর AIRDROP করতে পারবে। একবার ENTITY বানিয়ে CONFIGURE করলে তাকে আর ACCOUNT MANAGE নিয়ে ঝামেলা করতে হবে না। সে JUST AIRDROP PROJECT গুলোর ACCOUNT তথ্য SYLO তে ENROLL করবে, আর কাজ থাকবে MAIN ACCOUNT MANAGED, PROJECT এর ভেতরে।"
      ]
     },
     {
      "n": "1.3.4",
      "title": "Enroll System",
      "lines": [
       "☐ ENTITY A ——→ SYLO ENTITY → ENROLL SYSTEM",
       "  OA1  OA-2  OA-3  BR-4  BD-6  FA-1  AK-6 → PROJECT NAME",
       "  WEB3 USER ENROLL FEATURE এর মাধ্যমে সহজেই TRACK করতে পারবে যে একটা ENTITY USE করে কোন কোন PROJECT করেছে। ENROLL FEATURE টা USER কে সাহায্য করার জন্য BUILD করা। ENROLL FEATURE MAINLY LINK বা CONNECTOR দিয়ে কাজ করে, কোনো PROJECT ACCOUNT যুক্ত করতে SYLO ENTITY ACCOUNT SELECT করতে হয়, শুধু PROJECT ACCOUNT DETAILS।",
       "  ENROLL FLOW ⇒",
       "  [PROJECT CHOSE] → [ENTITY CHOSE] → [PROJECT ACCOUNT DETAILS] → [ENROLL ACCOUNT]"
      ]
     }
    ]
   },
   {
    "n": "1.4",
    "slug": "entity-intelligence",
    "title": "Entity Intelligence",
    "subs": [
     {
      "n": "1.4.1",
      "title": "Flags, Dynamic Pricing, ROI & Health Scan",
      "lines": [
       "☐ FLAGS, DYNAMIC PRICING, ROI, HEALTH SCAN FEATURE বলতে বোঝাচ্ছে:",
       "  অনেক সময় অনেক ACCOUNT BAN হয়ে যায়, তখন ENTITY তে FLAG করা যায়, যে এই ENTITY এর এই ACC এ সমস্যা, CHANGE করতে হবে।",
       "☐ DYNAMIC PRICING থাকবে। ACCOUNT এর WORTH CHECK করা যায়, DYNAMIC PRICING SYSTEM কিছু PARAMETER USE করে:",
       "  [DYNAMIC PRICING]",
       "  [FOLLOWER] [AGE] [USERNAME] [ENGAGEMENT]",
       "  এখন সব ACCOUNT তো CREATE করা হয় না, কিছু ACCOUNT BUY করা হয়, যেখানে BUY PRICE দেখা যায়।"
      ]
     },
     {
      "n": "1.4.2",
      "title": "Stored Credentials",
      "lines": [
       "ACCOUNT গুলোর FOLLOWER, AGE ও ENGAGEMENT এর উপর DEPEND করে CONTINUOUS PRICE CHANGE হতে থাকে, ROI ও PRICE MANUALLY ও বসানো যাবে।",
       "☐ ENTITY HEALTH SCAN মানে, কোনো INCOMPLETE ENTITY থাকলে ALERT করবে। ENTITY অনেক SECURITY CREDENTIAL COLLECT করবে:",
       "  EMAIL        : EMAIL-PASSWORD, EMAIL 2FA",
       "  EMAIL AGE    : RECOVERY-EMAIL, RECOVERY-EMAIL PASSWORD",
       "  EMAIL BACKUP CODE, RECOVERY 2FA, WORTH, BUY DATE, BUY PRICE",
       "  FOLLOWER, LAST-LOGIN, BUY PRICE",
       "  SELLER NAME, SELLER-PHONE, SOCIAL DETAILS",
       "  IMAP PASS, APP PASSWORD, ENTITY NAME",
       "  USERNAME, SEED PHRASE, PRIVATE KEY",
       "  STORED CREDENTIALS"
      ]
     }
    ]
   },
   {
    "n": "1.5",
    "slug": "local-account-and-exchange",
    "title": "Local Account & Exchange",
    "subs": [
     {
      "n": "1.5.1",
      "title": "Local Account",
      "lines": [
       "☐ LOCAL ACCOUNT হলো POWER USER দের জন্য। LOCAL ACCOUNT SYLO ENTITY এর একটা PART বলা যায়। (যেমন TWITTER SYLO ENTITY এর একটা PART) এখানে TWITTER এর একটি LOCAL ACCOUNT। IT'S SELF LOCAL ACCOUNT ENTITY শুধু DIVIDED PART। MULTIPLE SAME CATEGORY ACCOUNT STORE করতে LOCAL ACCOUNT FEATURE USE করা যায়। এখানে FOLLOWER বাড়ানো, কমানো যায়, WORTH ও সেট করা যায়। আর কিছু ACCOUNT PLATFORM CREDIT COLLECT করার জন্য CREATE ও ADD করা হয়। প্রতিটি ADD করে COMMIT দিলে STORE হবে।"
      ]
     },
     {
      "n": "1.5.2",
      "title": "Credit Tracking & Exchange Support",
      "lines": [
       "STORE হবে, এবং BALANCE UPDATE হবে। এইভাবে CREDIT, FOLLOWER TRACKING করতে পারবে। SYLO ENTITY এর FEATURES অন্তর্ভুক্ত: ACCESS, FLAGS, DYNAMIC PRICING, HEALTH SCAN, ROI বুঝাতে।",
       "☐ SYLO EXCHANGE ACCOUNT SUPPORT করে, SYLO এর একটি FEATURE এর মাধ্যমে EXCHANGE ACCOUNT MANAGE করা যাবে, যেটি POWER USER ও WEB3 USER দের জন্য BUILD করা হয়েছে। যারা WEB3 এর POWER USER তারা নিজেরা KYC করা ACCOUNT কিনে রাখে RESELLING বা Exchange campaign multiple এর REFERRAL এর জন্য। KYC করা ACCOUNT এর ক্ষেত্রে কে SELLER, তার FACE, NID DATA STORE করতে হয়।",
       "  [ACCOUNT DETAILS] [NID DATA] [FACE DATA] [SYLO EXCHANGE] [SELLER DATA]"
      ]
     },
     {
      "n": "1.5.3",
      "title": "Exchange Data Benefits",
      "lines": [
       "☐ FACE DATA ও NID DATA থাকায় কখনো লগইন বা মালিকানা নিয়ে সমস্যা হলে তাকে FIND করে সমাধান করা যায়।",
       "☐ SELLER DATA থাকায় কার থেকে কেনা হয়েছে জানা যাবে, কোনো সমস্যা হলে তাকে FIND করে সমাধান করা যাবে।",
       "☐ API KEY CONFIGURED থাকলে CONNECTED EXCHANGE ACCOUNT এর BALANCE ONE PORTFOLIO তে দেখা যাবে।",
       "  FACE VERIFY SOLUTION",
       "  SELLER FINDING & ACCOUNT OWNERSHIP FINDING",
       "  BALANCE UPDATE"
      ]
     }
    ]
   },
   {
    "n": "1.6",
    "slug": "backup-and-automation",
    "title": "Backup & Automation",
    "subs": [
     {
      "n": "1.6.1",
      "title": "Backup",
      "lines": [
       "BACKUP",
       "  MEMORIES   EVIDENCE   ENCRYPTED FILE",
       "  NORMAL FILE   ACCOUNT BACKUP",
       "☐ BACKUP SYLO এর আরও একটি FEATURE। এটির মাধ্যমে FILE UPLOAD করে BACKUP নিয়ে রাখা যায়, প্রয়োজনে DOWNLOAD করা যায় অনুমতি সাপেক্ষে। UNPOPULAR WEBSITE থেকে EVIDENCE STORE করতে GOOGLE DRIVE BEST হলেও LIMIT এর জন্য IMAGE/VIDEO UPLOAD করা সম্ভব হয় না। এখানে FILE ENCRYPTED থাকে, SO THERE IS NO SECURITY ISSUE। AYZEN যেকোনো MODULE DATA এখানে UPLOAD করা সম্ভব। MISSING হলে RESTORE বা NEW ACC এ MIGRATE করা যাবে।"
      ]
     },
     {
      "n": "1.6.2",
      "title": "Automation",
      "lines": [
       "☐ SYLO এর AUTOMATION বলতে DYNAMIC PRICING, AXTA EXTENSION ও ZYNTH AI (POWERED BY 8 PAX TECH LIMITED)। AXTA EXTENSION SYLO এর একটা HOOK।",
       "  AXTA",
       "  AUTOMATED LOGIN    APP SHORTCUT",
       "  QUICK VIEW   EASIER THAN SYLO   QUICK ACCESS"
      ]
     },
     {
      "n": "1.6.3",
      "title": "AXTA Extension",
      "lines": [
       "☐ AXTA EXTENSION CONNECT করবার পর USER কোনো STORED WEBSITE এ লগইন করতে গেলে, EMAIL/USERNAME ও PASSWORD AUTOMATIC FILLED UP হবে, যে ACCOUNT SELECT করা হবে। এটি AXTA এর ACCESS FEATURE (এর UPGRADE VERSION OF SYLO, HERE SYLO IS THE BACKEND)। পরবর্তীতে EMAIL বা 2FA CODE চাইলে AXTA SYLO থেকে কপি করে WEBSITE FILLED করে CONFIRM RUN করবে, CAPTCHA USER কে SOLVE করতে হবে, SYLO বা AXTA SECURITY BYPASS করে না (যা LIMITED)।",
       "☐ AXTA হলো SYLO এর QUICK ACCESS ও QUICK VIEW FEATURES। এই QUICK VIEW FEATURES এর মাধ্যমে APP না খুলেই EXTENSION দিয়েই EMAIL, 2FA VIEW করতে পারবে, আমাদের CREDENTIAL ও।"
      ]
     }
    ]
   },
   {
    "n": "1.7",
    "slug": "security-and-login",
    "title": "Security & Login",
    "subs": [
     {
      "n": "1.7.1",
      "title": "Secure Architecture",
      "lines": [
       "☐ SYLO আলাদা SECURE একটা APP, যেটি HTTPS PROTECTED, OIDC LOGIN FLOW আছে, POLICY ENGINE, EVENT BUS ও WORKFLOW SYSTEM আছে।",
       "☐ SYLO এ প্রতিটি ENTITY, LOCAL ACCOUNT সব ENCRYPTED থাকে এবং ARGON2ID দিয়ে SECURE। ENTITY VIEW করতে PIN / PASSKEY / VAULT PIN / VAULT PASSWORD / 2FA যদি SET করা থাকে লাগে।"
      ]
     },
     {
      "n": "1.7.2",
      "title": "Security Tiers & Guards",
      "lines": [
       "☐ SYLO SECURITY তে:",
       "  i) Passkey + Pin + Password + 2FA",
       "  ii) Passkey + Pin + 2FA",
       "  iii) PASSKEY",
       "  iv) Pin + PASS",
       "☐ যেখানে যেটাকে দরকার তিনটি SECURITY BLOCKER ADD করা হয়েছে, যেটা সবকিছু HOLD করে রাখা সহজ করে।",
       "☐ SYLO এর ENCRYPTION KEY আলাদা DATABASE এ STORE হয়, HACKING থেকে বাঁচতে। SYLO এ RUNTIME MONITOR হয়, ABNORMAL ACTIVITY DETECT করতে পারে। DETECT করে POSSIBLE WAY FINDOUT করে VALIDATE করে। PREDICTED CAUSE REPORT করে। SAFETY GUARD মুহূর্তে যা PARAMETER BASED।"
      ]
     },
     {
      "n": "1.7.3",
      "title": "Incident Response & DR",
      "lines": [
       "☐ আরেকটা GUARD আছে STRICT, যা EVEN KILL SWITCH TRIGGER করে ADMIN APPROVAL এ।",
       "☐ DR মানে, DISASTER RECOVERY যা কোনো APP CRASH করলে বা APP এ KILL SWITCH TRIGGER হলে DATA AGAIN RECOVER করতে CAPABLE।",
       "☐ ECC দিয়ে TESTED CYBER ATTACK থেকে PREVENT করতে, (VERCEL + RENDER + RESEND + CLOUDFLARE + SUPABASE + REDIS + AI PROVIDER) দিয়ে STRUCTURED।",
       "☐ APP টি 16k FRONTEND ও 16k BACKEND নিয়ে গঠিত, EXPAND করে 25k, 25k হতে পারে। এবং FREE-TIER এ CONTINUE।"
      ]
     },
     {
      "n": "1.7.4",
      "title": "Login Flow & Monitoring",
      "lines": [
       "☐ APP এর RUNTIME ERROR CATCH করতে POSTHOG এবং SENTRY CONFIGURE করা আছে, কোনো ERROR হলে ALERT আসে, CI/CD TEST চলে প্রতি DEPLOY ও COMMIT এ।",
       "☐ SYLO এর OWN LOGIN FLOW + CLERK INTEGRATION করা আছে। SYLO এর OWN LOGIN FLOW তে USERNAME, EMAIL CODE (RESEND), CAPTCHA, 2FA VERIFIER, REFERRAL REQUIRED LOGIN SYSTEM ও আছে BUT OFF করা। RATE LIMIT করা আছে 5 বা 6 ATTEMPT, PASSWORD RESET SYSTEM আছে 3 ATTEMPT, EMAIL CODE 3, 2FA 3। IP MONITORING, DEVICE, LOCATION, TIMELINE COLLECT করা হয়।"
      ]
     },
     {
      "n": "1.7.5",
      "title": "Clerk, OIDC & Modules",
      "lines": [
       "☐ CLERK INTEGRATION আছে GOOGLE, FACEBOOK, GITHUB LOGIN এর জন্য, যদিও এটি দিয়ে CREATE করলেও PASSWORD SET করতে হয়।",
       "☐ SYLO এর AYZEN POWERED OIDC PROVIDER বলতে, AYZEN ACCOUNT দিয়ে সবকিছুতেই SYLO ACCOUNT খোলা বা লগইন করা যায়। SYLO এর সব APP এই।",
       "☐ SYLO এর CONNECTED MODULE হলো SKARN ও VERVE। SYLO এ ENROLLED ACCOUNT এর কাজের FLOW TRACK করতে SKARN APP BUILD করা। SKARN ও SYLO CONNECT করলে, যেকোনো PROJECT TRACK করা সম্ভব। SKARN এ যে কাজ করা হয় তা সহজে মনিটর করা যায়।"
      ]
     }
    ]
   },
   {
    "n": "1.8",
    "slug": "connected-modules-and-ai",
    "title": "Connected Modules & AI",
    "subs": [
     {
      "n": "1.8.1",
      "title": "SKARN Tracking",
      "lines": [
       "☐ নতুন PROJECT DEPLOY হলে, শুধু TASK ADD করে রাখি কাজের। FOR SUPPOSE আমরা HIMARI নামের একটি WEBSITE এ কাজ করছি, প্রতিদিন SIGN IN করতে হয়, আমরা 100+ ACCOUNT দিয়ে করলে প্রত্যেক ACCOUNT SYLO এ ENROLL করে PROJECT এ ASSIGN করলাম। প্রত্যেক দিন কোন কোন ACCOUNT SIGN IN করলাম তা SUBMIT করলাম, কোন PROOFING, LOSS থাকা বা COST থাকলে INCLUDE করলাম। মানে যে যে ACCOUNT এ SIGN IN থাকে SKARN ও ALERT দিবে ও BOARD নিশ্চিত রাখবে। আমরা সহজেই বুঝতে পারবো কোন ACCOUNT এ কি কাজ হচ্ছে। আমরা কত খরচ বা লাভ হলো তা TRACK করতে পারবো।",
       "  SYLO X SKARN"
      ]
     },
     {
      "n": "1.8.2",
      "title": "VERVE & ZYNTH AI",
      "lines": [
       "☐ যারা MULTIPLE ACCOUNT FARMING করে তারা SYLO কে VERVE এর সাথে CONNECT করুক, তারা তাদের ACCOUNT SELL করতে পারবে তাও ESCROW PAYMENT SYSTEM এর মাধ্যমে, NOTHING TO LOSE, NOTHING TO FEAR।",
       "☐ SYLO তে ZYNTH AI INTEGRATED, ZYNTH AI SYLO এর MCP AGENT হিসেবে কাজ করে। ZYNTH AI কে কোনো ACCOUNT এর কোন DETAILS লাগলে (যেমন PASSWORD, USERNAME, CREDENTIAL), (EMAIL CODE, 2FA, BACKUP CODE) ASK করলে বলে দিতে পারবে।"
      ]
     },
     {
      "n": "1.8.3",
      "title": "ZYNTH, Developer Key & AZN",
      "lines": [
       "☐ ZYNTH AI কে বললে ACCOUNT DETAILS UPDATE করে দেবে। ZYNTH AI ENTITY ও CREATE করতে পারবে।",
       "☐ SYLO কে CHATGPT, CLAUDE, GEMINI দিয়ে USE করতে পারবো। আমরা SYLO এর DEVELOPER KEY SCOPED, ZONE SELECT করে নিতে পারবো, যা দিয়ে SYLO এর API CALL ও SECURE করা যায়।",
       "☐ SYLO তে AZN CURRENCY হিসেবে ব্যবহৃত হয়, INITIAL PRICE = 0.01$, SYLO এ সব PURCHASE AZN দিয়ে করা যায়।",
       "  AZN PAYMENT FLOW: N8N -> PURCHASE -> HYBRIDICITY"
      ]
     }
    ]
   }
  ]
 },
 {
  "n": 2,
  "slug": "use-cases",
  "title": "USE-CASES",
  "desc": "AIRDROP, ACCOUNT FARMING ও INCOME PATH",
  "topics": [
   {
    "n": "2.1",
    "slug": "airdrop-farming",
    "title": "Airdrop Farming",
    "subs": [
     {
      "n": "2.1.1",
      "title": "Airdrop Farming I",
      "lines": [
       "☐ SYLO USE-CASES:-",
       " 1) আমরা যদি একটা AIRDROP ACCOUNT করি LEGIT তাহলে MINIMUM AS LOW AS 1$ তো পাবোই, একজন ১ এর বদলে যদি আমরা ২০০টা একাউন্ট করি, তাহলে আমরা ২০০ ডলার পাবো।",
       "      ২ ACC → 1 DOLLAR",
       "      200 ACC → 100 DOLLAR",
       "☐ এখন আমরা SYLO USE করে সহজেই ACCOUNT MANAGE করে AIRDROP করতে পারি। আমরা AIRDROP PROGRESS ও TRACK করতে পারি, SKARN CONNECT করে।"
      ]
     },
     {
      "n": "2.1.2",
      "title": "Airdrop Farming II",
      "lines": [
       " ii) LIMITED FCFS AIRDROP আসলে, আমরা যদি FAST না করি তাহলে আমরা বেশি ACCOUNT করতে পারবো না। এখানে আমরা SYLO USE করে দ্রুত লগইন করতে পারবো, SO আমাদের AIRDROP MISS হবে না।",
       " iii) আমরা যারা TWITTER FARMING করি, আমরা চাইলে সহজেই MULTIPLE ACCOUNT দিয়ে ENGAGEMENT করে আমরা TWITTER BUILD করতে পারি।",
       " iv) আমরা FAKE REFERRAL ADD করতে SYLO MULTIPLE ACCOUNT লগইন করে আমরা দ্রুত ও সহজেই আমাদের কাজ করতে পারবো।"
      ]
     }
    ]
   },
   {
    "n": "2.2",
    "slug": "credits-and-services",
    "title": "Credits & Services",
    "subs": [
     {
      "n": "2.2.1",
      "title": "Credits & Services I",
      "lines": [
       " v) আমরা চাইলে SYLO এ MULTIPLE ACCOUNT LOAD করে FOLLOWER, ENGAGEMENT SELL করতে পারি।",
       " vi) আমরা চাইলেই MULTIPLE ACC SYLO এর মাধ্যমে লগইন করে PLATFORM CREDIT CLAIM করে রাখলাম, পরে IN-FUTURE তা কাজে দেবে।",
       " vii) COINGECKO, AI PROVIDER FREE CREDIT ACCOUNT COLLECT করে রাখলে আমরা তা ব্যবহার করলাম।"
      ]
     },
     {
      "n": "2.2.2",
      "title": "Credits & Services II",
      "lines": [
       " viii) SYLO দিয়ে আমরা CMO, CM এর কাজ করতে পারি খুব সহজেই। আবার ID BAN / REPORT REQUEST পাঠাতে আমরা SYLO এর মাধ্যমে বিভিন্ন একাউন্ট দিয়ে করতে পারি।",
       " ix) GOOGLE PLAYPOINT COLLECT করে আমরা একটা PASSIVE INCOME করতে পারি যা সুবিধাতে SYLO এর প্রয়োজন।",
       " x) আমরা যদি মাসে ২৫ পয়েন্ট পাচ্ছি, বছরে ২০০ POINT হবে, যা দিয়ে আমরা COD UC/CP কিনলে POINT এর দাম হবে ২০০, MAIL ৫০ টাকা যা আমরা সহজেই SYLO দিয়ে করতে পারি।"
      ]
     }
    ]
   },
   {
    "n": "2.3",
    "slug": "account-resale-and-income",
    "title": "Account Resale & Income",
    "subs": [
     {
      "n": "2.3.1",
      "title": "Account Resale",
      "lines": [
       " xi) SYLO IOS/108 দিয়ে নিলাম, আর",
       "      100 GMAIL → 200×100",
       "      ⇒ 20k + (50×100)",
       "      ⇒ 25k",
       "    এখানে 1k খরচ করে আমরা সহজেই 20-25k INCOME করতে পারবো।",
       " xii) LINKEDIN, GITHUB ACCOUNT SYLO তে STORE করে পরে তা 500-1000 তে সেল করে দিই। আবার আমরা চাইলে Google, twitter, discord, instagram Store করে আমরা SELL করতে পারি।"
      ]
     },
     {
      "n": "2.3.2",
      "title": "Income Path",
      "lines": [
       " xiii) আমরা শুধু 1k এর বিনিময়ে, TWITTER ENGAGEMENT, FAKE REFERRAL, FOLLOW, ENGAGEMENT SELL করতে পারবো। খুব সহজে platform credit collect করে পরে sell করতে পারবো। google Play Point collect করে ৭-৮ মাসে 10X RETURN ENSURE করতে পারবো। PRICE ও 2.5X হবে। আবার, MAIL এর দাম পাবো, LINKEDIN, GITHUB SYLO দিয়ে আমরা 500 করে প্রোফাইল CREATE করে পারবো, TWITTER, DISCORD, INSTAGRAM ETC করতে পারবো। LOCAL ACCOUNT MINIMUM 50, HIGHEST 200-300 TK এ SELL করতে পারবো।"
      ]
     }
    ]
   },
   {
    "n": "2.4",
    "slug": "platform-strengths",
    "title": "Platform Strengths",
    "subs": [
     {
      "n": "2.4.1",
      "title": "Platform Strengths I",
      "lines": [
       " xiv) SYLO SECURE, FAST ACCESS করার জন্য, FAST VIEW করা হবে। SYLO এ ACCOUNT নির্দিষ্ট স্থানে রাখা হবে।",
       " xv) SYLO VERVE এর সাথে CONNECT করে SELL ও করা হবে।",
       " xvi) SYLO ডিটেইল MAIL + 2FA + CREDENTIAL KEEPER, BITKEEP, PASSWORD MANAGER এর মতো কিছু CREDENTIAL KEEPER।",
       " xvii) SYLO আবার একটা EXTENSION ব্যবহার করা হবে।"
      ]
     },
     {
      "n": "2.4.2",
      "title": "Platform Strengths II",
      "lines": [
       " xviii) Policy Engine থাকে তাই সব auth PROTECTED, USAGE TRACKABLE, কারণ কোন PATH এ কোন সময় REQUEST লাগছে তা COLLECT হয়ে থাকে।",
       " xix) SYLO যদি HACK ও হয় USER DATA PROTECTED থাকবে, ENCRYPTION ব্যবহার করে DATABASE STORE হয়।",
       " xx) SYLO CRASH হলে NORMAL এ BACK আনতে প্রস্তুত DR MODE থাকবে, DISASTER RECOVERY।"
      ]
     },
     {
      "n": "2.4.3",
      "title": "Platform Strengths III",
      "lines": [
       " xxi) আমরা চাইলে আমাদের PRIVATE IMAGE, VIDEO STORE করতে পারি SYLO CLOUD এ।",
       " xxii) আমরা SYLO CLOUD এ EVIDENCE ও রাখতে পারি, কেউ কোনো TRACE ও পাবে না, SECURE ও ENCRYPTED থাকবে FILE।"
      ]
     }
    ]
   }
  ]
 }
];
