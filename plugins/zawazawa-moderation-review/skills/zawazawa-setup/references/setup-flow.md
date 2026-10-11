# 初回設定手順

この手順はmacOSまたはWindowsのローカル環境向けである。Web・モバイルだけの環境やLinuxでは設定を変更せず、正式対応外と伝えて止める。利用者には対象グループのZAWAZAWA管理画面を操作できる権限が必要だが、これはZAWAZAWA側の権限を指し、WindowsやmacOSの管理者権限を指さない。Node.jsの導入時に限り、選ぶ方法によってはOSの管理者権限が求められる。

依存関係の確認と導入が済むまでは、プラグインのMCPツールを呼び出さない。MCPサーバーが起動していない、またはツールが見えない場合に、ツール名を推測して呼んだり、別のプラグインやソースツリーで代用したりしない。

## 1. 実行環境と実際のプラグイン場所

1. このskillが読み込まれた実ファイルの場所を確認する。その`SKILL.md`を含むディレクトリを`skillRoot`とし、`skillRoot/../..`を実際に読み込まれたプラグインルート`pluginRoot`として解決する。これらのパスは絶対パスにする。`pluginRoot/scripts/runtime-launcher.mjs`を`launcherPath`として使い、セットアップスクリプトは`skillRoot/scripts/init-workspace.mjs`から実行する。プラグインがインストールキャッシュにあるなら、その場所が使うべき`pluginRoot`である。別のソースチェックアウトへ切り替えたり、公開ソースの依存関係を実行時に使ったりしない。実際のskillの場所を特定できない場合は止める。
2. macOSまたはWindowsのローカル環境であることを確認する。対象WikiのZAWAZAWA管理画面を操作できる権限がない場合は、認証へ進まず止める。
3. `node --version`が`v24`以上であり、対応するnpmが使えることを確認する。Node.js 24 LTSを標準にする。Windowsでは`npm.cmd`の場所からnpmのJavaScript CLI `node_modules/npm/bin/npm-cli.js`の絶対パスを特定し、`npm.ps1`やPowerShell実行ポリシーの全体変更を使わない。ランチャーにはラッパーの`.cmd`ではなく、このCLIファイルの絶対パスを渡す。PATH上のNodeとnpm.cmdが別のNode.js導入先にある場合は、ランチャーをnpm.cmdと同じ導入先の公式`node.exe`で実行する。
4. Node.jsが無い、または24未満なら、Node.js 24 LTSの公式配布物、外部通信、インストール方法によってはOS管理者権限が必要なことを説明して、ソフトウェア導入の承認を得る。承認後は公式配布元だけを使う。インストーラー完了後はCodexアプリを完全終了して再起動する。既に開いているアプリは起動時のPATHを保持するためである。再起動後にこの初回設定を再開し、Node.jsとnpmの版を読み直す。アプリを再起動する前に先へ進まない。

## 2. 運用フォルダと初期文書

未確定の値だけをまとめて尋ねる。

- 運用フォルダの絶対パス
- `https://z.wikiwiki.jp/m/<グループキー>/...`形式の管理画面URL
- 一覧と報告に出すWiki表示名

運用フォルダは公開リポジトリ、ソースチェックアウト、インストール済みプラグインまたはそのキャッシュの外にある専用フォルダにする。解決済みパスを使って同一場所や配下になっていないことを確かめる。Windowsでは大文字小文字を区別しない。Finderやエクスプローラーで先に作成した空のフォルダは保存先として使える。未管理のファイルがある場所は選ばない。`zawazawa.config.json`、運用基準、判断事例、結果報告、認証情報をソースツリー、プラグインキャッシュ、公開リポジトリへ保存しない。

同梱の統一テンプレートを初期案として使い、初期モードは`restricted`固定にする。テンプレートには著者の原神Wiki由来の慣行が含まれるため、対象Wikiに合わせて全文を確認し、節ごとの要点を利用者へ示す。利用者が修正を求めた場合は、生成前に具体的な差分を示して承認を得る。テンプレートをそのまま使うか、提示済みの差分を採用するかが確定するまで`--apply`を使わない。初回設定中に`autonomous`を提案したり、選択肢へ加えたりしない。

セットアップスクリプトを最初に`--dry-run`で実行する。以下は一行のコマンド例で、`<...>`部分は実際の値に置き換える。解決した`skillRoot`を含む各パスと値は一つの引数としてシェルの規則で引用し、引用符を含む値では区切り文字を正しくエスケープする。PowerShellの単一引用符内では`'`を`''`と書く。macOSのzshでは単一引用符内の`'`を`'\''`の形でエスケープする。値をコマンド文字列として評価・展開しない。

Windows PowerShell:

```powershell
node '<skillRoot>\scripts\init-workspace.mjs' --destination '<絶対パス>' --admin-url '<管理画面URL>' --display-name '<Wiki表示名>' --dry-run
```

macOS zsh:

```sh
node '<skillRoot>/scripts/init-workspace.mjs' --destination '<絶対パス>' --admin-url '<管理画面URL>' --display-name '<Wiki表示名>' --dry-run
```

再開時も`--dry-run`を省略しない。編集済みの`運用基準.md`はスクリプトから`preserve`として報告されるが、これは承認済みの差分を意味しない。前回の承認済み編集と現在の差分が一致し、固定名の生成物がすべて揃い、設定が`restricted`であることを別途確認できた場合に限り、次の未完了工程へ進む。承認内容を確認できない場合、未管理の項目、生成物の不足、その他の内容差分が一つでもある場合は、再開済みと推測せず止める。

返されたファイル一覧、抽出したグループキー、統一テンプレート、`restricted`で作ることを示す。衝突があれば上書きせず、そのファイルと理由を伝える。空の既存フォルダは初期化に使える。`skillRoot/assets/templates/運用基準.md`を全文読み、節ごとの要点を示す。テンプレートをそのまま使うか、利用者が承認した具体的な差分を採用することが確定した後に限り、同じ引数で`--apply`を実行する。

生成後の運用フォルダにある`運用基準.md`を全文読み戻す。利用者が提示済みの差分を採用すると決めた場合は、そのファイルだけへ反映して再び全文読み戻す。他の生成ファイルへ承認を流用しない。生成物に認証情報を入れない。`根拠資料.md`と空の`判断事例.md`は基準保守時だけ使い、通常の通報対応では読まない。

## 3. 永続ランタイムの準備

プラグインキャッシュはCodexが作り直すことがあるため、MCPサーバーのコードと依存関係はキャッシュの外にあるユーザー領域のランタイムへ置く。`pluginRoot`から`launcherPath`を呼び出し、`--print-root`が現在のコードに対応する準備済みランタイムの絶対パスを返すか最初に確認する。これはローカル確認だけで、ネットワーク取得やインストールをしない。

```sh
node "<launcherPath>" --print-root
```

成功してパスが返ったら、その値を`runtimeRoot`として以降の依存関係確認、認証、診断に使う。準備済みランタイムはmacOSで`~/Library/Application Support/ZAWAZAWA Moderation Review/runtimes/<version>-<fingerprint>`、Windowsで`%LOCALAPPDATA%\ZAWAZAWA Moderation Review\runtimes\<version>-<fingerprint>`に保存される。同じコードと依存関係ならプラグインキャッシュが消えて作り直されてもこのランタイムを再利用する。コードまたはlockfileが変わると別のフィンガープリントになり、新しいランタイムを一度準備する。

`--print-root`が標準エラーに`Matching persistent runtime is not prepared.`と出して終了した場合だけ、永続ランタイムの準備へ進む。Node.jsの導入が済み、npmパッケージと専用Chromiumをネットワーク取得する承認が既にあることを確かめる。以前のセットアップでこの導入を承認済みなら再度尋ねない。承認が無い場合は、外部通信とソフトウェア取得を説明してから承認を得る。`--npm-cli`には、npmラッパーではなく`node_modules/npm/bin/npm-cli.js`の絶対パスを渡す。Windowsでは`npm.cmd`のある公式Node.js導入先からこのパスを特定し、ランチャーもその導入先の`node.exe`で実行する。別のエラーが出た場合は準備済み状態がないと決めつけず、その原因を先に解消する。

```sh
node "<launcherPath>" --prepare --npm-cli "<absolute npm/bin/npm-cli.js>" --print-root
```

この処理はコードとlockfileのフィンガープリントを含む永続ランタイムを作り、npm依存関係を`npm ci --ignore-scripts`で導入する。準備の進捗は標準エラーに出て、成功すると標準出力に`runtimeRoot`だけが返る。準備済みマーカーは、依存関係の実際のimport確認に成功してから作られる。失敗時は認証へ進まず、表示された安全な診断情報で止める。MCPサーバーの通常起動時はランタイムを実行するだけで、npmやChromiumをネットワーク取得しない。

`runtimeRoot`を作業ディレクトリにして`node ./scripts/check-dependencies.mjs`を実行し、依存関係のimport確認が成功することを確かめる。次にPlaywright APIで`chromium.executablePath()`のファイルが存在し、`chromium.launch({ headless: true })`と`browser.close()`が成功することを確認する。実行例は次のとおり。

```sh
node --input-type=module -e "import { access } from 'node:fs/promises'; import { chromium } from 'playwright-core'; await access(chromium.executablePath()); const browser = await chromium.launch({ headless: true }); await browser.close();"
```

Playwrightが示すChromium実行ファイルだけが見つからない場合は、`runtimeRoot`を作業ディレクトリにして次を一度実行し、同じAPI検証を繰り返す。`npm ci --ignore-scripts`ではChromiumは導入されない。ランタイムキャッシュが作り直されても、Chromiumの検証に成功したら再導入しない。

```sh
node ./node_modules/playwright-core/cli.js install chromium
```

`runtimeRoot`には実行コード、`.mcp.json`、npm依存関係だけを保存し、設定、運用基準、認証情報、通報データ、結果報告を置かない。ChromiumはPlaywrightのユーザーキャッシュへ別途保存される。新しいランタイムを準備した後、またはChromiumを導入した後はCodexアプリを完全終了して再起動し、同じ初回設定チャットを開いて「`$zawazawa-setup`で初回設定を再開」と依頼する。作成済みの運用フォルダと、前回承認した基準の差分を引き続き使う。アプリの都合で新しいローカルタスクが必要な場合も、そのフォルダを開く。ランタイムとChromiumの検証が済んでいれば再導入せず、必要なアプリ再起動後に同じ手順を再開する。

以降は`runtimeRoot`のコードを対象に依存関係確認や認証を行う。診断は`node "<runtimeRoot>/scripts/diagnose-mcp.mjs"`で実行する。プラグインキャッシュの`node_modules`、ソースチェックアウト、運用フォルダで`npm ci`を実行して直そうとしない。

## 4. 認証と読み取り確認

依存関係の確認後、必要なアプリ再起動が終わってから初めて、現在のプラグインが提供するMCPツールを確認する。ツールが見つからない場合は存在を仮定せず止める。

1. `runtimeRoot`を作業ディレクトリにして`node ./scripts/zawazawa-auth.mjs <グループキー>`を実行する。認証スクリプトとMCPサーバーは同じ永続ランタイムのコード・依存関係を使う。
2. 開いた専用ブラウザで、利用者本人にログインと対象グループの確認をしてもらう。Cookie、パスワード、トークンを会話へ貼らせない。
3. 運用フォルダにある`zawazawa.config.json`の絶対パスを`get_moderation_target_config`へ渡し、表示名、グループキー、`restricted`を読み戻す。
4. 認証済みの読み取り専用入口で接続を確認する。通報への変更、一覧判断の送信、実行ツールは呼ばない。

完了時は、作成したフォルダ、テンプレート、対象、`restricted`、認証・接続の結果を示す。次は運用フォルダをローカルプロジェクトとして開いたタスクから`$zawazawa-moderation`を使うよう案内する。Claude Codeの既存利用者には`/zawazawa-moderation-review:zawazawa-moderation`も案内する。特に追加の指示がなければ、未処理のZAWAZAWA通報を調べる挙動になると説明する。
