<div dir="rtl">

[English](README.md) · **עברית** · [Español](README.es.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Português (Brasil)](README.pt-BR.md) · [Deutsch](README.de.md)

# Seat Console

**קונסולת ווב אחת לכל חשבונות סוכני הקוד שלך.** מריצים סשנים של Claude Code,‏ Codex ו־Antigravity CLI זה לצד זה, אחד לכל חשבון, מלשונית דפדפן או מהטלפון. מתארח אצלך, בלי תלויות npm.

![Seat Console](docs/media/seat-console-tour.gif)

<sub>מופע הדגמה עם CLI מזויף ונתונים מומצאים.</sub>

## תכונות

- **מושבים:** סרגל צד אחד לכל החשבונות; מושבי Claude Code,‏ Codex ו־Antigravity; תפריט מודלים לכל מושב.
- **עמיד להפעלה מחדש:** כל שיחה רצה בתהליך רקע נפרד; השרת מתחבר אליה מחדש אחרי הפעלה מחדש, ואחרי קריסת מחשב מציע להמשיך.
- **אישורים:** מצבי `auto`,‏ `ask` (כרטיסי אישור/דחייה) ו־`bypass` לכל שיחה.
- **מדי שימוש:** חלון 5 שעות וחלון שבועי לכל מושב, זמני איפוס, אזהרה ב־90 %; ממתינים לאיפוס, לא עוברים לחשבון אחר.
- **טלפון:** PWA דרך Tailscale ובוט Telegram עם כפתורים, תשובות, תמונות וקבצים.
- **פרויקטים רב־צדדיים:** בריף אחד, כמה מושבים, תלויות ואינטגרציה בסוף.
- **15 שפות** לדף ולבוט, כולל עברית וערבית מימין לשמאל.

**הכלל הקבוע:** כל מושב שייך לחשבון אחד. מושב שהגיע למגבלה ממתין לאיפוס; העבודה לא עוברת לחשבון אחר כדי לעקוף מגבלה.

## התחלה מהירה

**לנסות בדקה, בלי חשבון.** זה מפעיל מופע בדיקה נפרד עם CLI מזויף שמחזיר את מה ששולחים (Node.js 22 ומעלה):

</div>

```sh
git clone https://github.com/beriki770-ship-it/seat-console.git && cd seat-console
cp seats.example.json seats.json && sed -i.bak "s#C:/Users/you/projects#$HOME#" seats.json
node console/server.mjs --port 4852 --data /tmp/seat-console-try --claude console/fixtures/fake-claude.mjs
```

<div dir="rtl">

פותחים את <http://127.0.0.1:4852> ושולחים הודעה למושב. ב־Windows ‏(PowerShell):

</div>

```powershell
git clone https://github.com/beriki770-ship-it/seat-console.git; cd seat-console
(Get-Content seats.example.json) -replace 'C:/Users/you/projects', ($HOME -replace '\\', '/') | Set-Content seats.json
node console\server.mjs --port 4852 --data "$env:TEMP\seat-console-try" --claude console\fixtures\fake-claude.mjs
```

<div dir="rtl">

**שימוש אמיתי:** עורכים את `seats.json` (רשומה לכל חשבון), מחברים כל מושב פעם אחת, ומפעילים את הקונסולה:

</div>

```sh
sh seat.sh dev --login
sh console/start-console.sh
```

<div dir="rtl">

המדריך המלא, השאלות הנפוצות והאזהרה המשפטית נמצאים ב־[README באנגלית](README.md).

</div>
