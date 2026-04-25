// @ts-check
// Seed text snippets shipped with a fresh install. Edit this file to change
// the default text-snippet library that populates on first run.
//
// Each entry pairs a filename-style `name` with a small `content` body
// crafted to exercise the seed snippets and chains — e.g. sales.csv feeds
// the CSV / column / aggregate snippets; users.json feeds the jq chains;
// messy.txt feeds the whitespace / clean-and-normalize chain; script.sh
// feeds the comment-toggle snippet and the keep/skip matching snippets.

/** @type {{name: string, content: string}[]} */
export const TEXT_SNIPPETS_SEED = [
  {
    name: 'sales.csv',
    content:
      'region,product,quantity,revenue\n' +
      'North,Widget,12,240\n' +
      'North,Gadget,5,175\n' +
      'South,Widget,8,160\n' +
      'South,Gizmo,3,90\n' +
      'East,Widget,20,400\n' +
      'East,Gadget,7,245\n' +
      'West,Gizmo,11,330\n' +
      'West,Widget,9,180',
  },
  {
    name: 'users.json',
    // Minified on purpose: makes Pretty JSON's effect obvious, and users can
    // then pipe the result back through Minify JSON / Sort JSON keys.
    content:
      '[{"name":"Ada","role":"engineer","active":true},' +
      '{"name":"Grace","role":"admiral","active":true},' +
      '{"name":"Alan","role":"mathematician","active":false},' +
      '{"name":"Katherine","role":"engineer","active":true}]',
  },
  {
    name: 'urls.txt',
    content:
      'https://example.com/\n' +
      'https://httpbin.org/get\n' +
      'https://api.github.com/\n' +
      'https://www.wikipedia.org/',
  },
  {
    name: 'repos.txt',
    content:
      'torvalds/linux\n' +
      'microsoft/vscode\n' +
      'rust-lang/rust\n' +
      'golang/go\n' +
      'python/cpython',
  },
  {
    // Leading / trailing spaces, internal whitespace runs, a split paragraph
    // (lines 4 + 5), and blank-line runs are all intentional — the point is
    // to exercise the full Clean & normalize chain (whitespace rebuild,
    // then paragraph-line joining) along with every individual whitespace
    // snippet.
    name: 'messy.txt',
    content:
      '   The   quick  brown   fox    jumps over the lazy dog.    \n' +
      '\n' +
      '\n' +
      '   Pack my box  with five    \n' +
      '      dozen liquor  jugs.\n' +
      '\n' +
      '\n' +
      'The five boxing wizards  jump quickly. ',
  },
  {
    name: 'todo.txt',
    content:
      'buy milk\n' +
      'send invoice to ACME Corp\n' +
      'book dentist appointment\n' +
      'email Alice about roadmap\n' +
      'pick up dry cleaning\n' +
      'water the plants',
  },
  {
    name: 'script.sh',
    content:
      '# fetch latest and bail on error\n' +
      'git pull --rebase\n' +
      '# build\n' +
      'npm install\n' +
      'npm run build\n' +
      'npm test\n' +
      '# deploy\n' +
      './deploy.sh production',
  },
  {
    // Quoted CSV — the canonical case where `FS = ","` falls over and
    // FPAT is the right answer. Bio fields contain commas inside double
    // quotes; a comma-FS parser would split them into the wrong number
    // of fields. Pairs with the seeded `Parse CSV (FPAT)` snippet.
    name: 'quoted.csv',
    content:
      'name,age,bio\n' +
      'Alice,30,"Loves cats, dogs, and llamas"\n' +
      'Bob,25,"Prefers tea, not coffee"\n' +
      'Carol,40,"Knows R, Python, and SQL"\n' +
      'Diana,28,"Speaks French, German"',
  },
  {
    // Deliberately themed `ls -l` output for the "Parse ls -l
    // (FIELDWIDTHS)" snippet. Fixed widths: perms(10) + " "+links(2) +
    // " "+owner(7) + " "+group(8) + " "+size(7) + " "+date(12) +
    // " "+name. After a parse, the owner/group/filename columns read
    // like a dossier — the reader can infer a particular Bond villain
    // from the convergence of clues (SPECTRE, Piz Gloria, the Persian
    // cat, Number 1, Tracy). Included as a seed so users have a
    // dataset on hand to exercise FIELDWIDTHS right after reading the
    // docs.
    name: 'mi6-intercept.txt',
    content:
      'total 432\n' +
      '-rw-------  1 ernst   spectre      314 Apr 22  1963 persian-grooming.log\n' +
      'drwx------  3 ernst   spectre     4096 Feb  9  1964 piz-gloria/\n' +
      '-rwx------  1 ernst   spectre     2711 Sep 12  1965 volcano-ventilation.sh\n' +
      '-rw-------  2 ernst   spectre     8192 Jul  1  1971 diamonds-laundry.db\n' +
      '-rw-------  1 ernst   spectre      108 Mar 18  1969 tracy-mi6-report.enc\n' +
      '-rw-r--r--  1 ernst   spectre     1024 Oct 27  1974 allied-chem-invoice.pdf\n' +
      'drwxr-xr-x  4 number1 octopus     4096 Jun  1  1967 op-thunderball/\n' +
      'lrwxrwxrwx  1 ernst   spectre       14 Nov 15  1967 boss -> /home/number-one\n' +
      '-rw-------  1 ernst   spectre      666 Dec 31  1969 yule-toast-tracy.log\n' +
      '-rw-r--r--  1 ernst   spectre     1962 Oct 13  1983 white-cat-portrait.jpg',
  },
  {
    // Fixed-width columnar data with a ragged trailing field — ideal test
    // input for the Snippet dialog's "Fixed Columns…" picker. Auto-detect
    // should land on FIELDWIDTHS = "6 7 *" (6-char code, 7-char count,
    // variable-length description), and the trailing-* checkbox should
    // self-tick because description lengths vary across rows.
    name: 'inventory.txt',
    content:
      'code  count  description\n' +
      'A001     12  Steel widgets (lightly used)\n' +
      'A002      5  Polished brass fittings, imported\n' +
      'A003     48  Wooden planks\n' +
      'A004      1  Vintage brass telescope w/ case\n' +
      'B100    200  Screws',
  },
  {
    name: 'logs.txt',
    content:
      'ERROR  disk full\n' +
      'WARN   slow query\n' +
      'INFO   user login\n' +
      'ERROR  disk full\n' +
      'ERROR  disk full\n' +
      'WARN   slow query\n' +
      'INFO   user login\n' +
      'INFO   user logout\n' +
      'ERROR  network timeout\n' +
      'ERROR  disk full\n' +
      'WARN   slow query',
  },
];
