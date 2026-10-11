# 初回設定手順

この手順はmacOSまたはWindowsのローカル環境向けである。Web・モバイルだけの環境やLinuxでは設定を変更せず、正式対応外と伝えて止める。利用者には対象グループのZAWAZAWA管理画面を操作できる権限が必要だが、これはZAWAZAWA側の権限を指し、WindowsやmacOSの管理者権限を指さない。Node.jsの導入時に限り、選ぶ方法によってはOSの管理者権限が求められる。

依存関係の確認と導入が済むまでは、プラグインのMCPツールを呼び出さない。MCPサーバーが起動していない、またはツールが見えない場合に、ツール名を推測して呼んだり、別のプラグインやソースツリーで代用したりしない。

## 1. 実行環境と実際のプラグイン場所

1. このskillが読み込まれた実ファイルの場所を確認する。その`SKILL.md`を含むディレクトリを`skillRoot`とし、`skillRoot/../..`を実際に読み込まれたプラグインルート`pluginRoot`として解決する。npmコマンドの作業ディレクトリは常にこの`pluginRoot`にする。セットアップスクリプトは`skillRoot/scripts/init-workspace.mjs`から実行する。プラグインがインストールキャッシュにあるなら、その場所が使うべきプラグインルートである。別のソースチェックアウトへ切り替えたり、ソースとキャッシュが異なるのにソース側で`npm ci`したりしない。実際のskillの場所を特定できない場合は止める。
2. macOSまたはWindowsのローカル環境であることを確認する。対象WikiのZAWAZAWA管理画面を操作できる権限がない場合は、認証へ進まず止める。
3. `node --version`が`v24`以上であり、npmが使えることを確認する。Node.js 24 LTSを標準にする。Windowsではnpmコマンドに`npm.cmd`を使い、PowerShellの`npm.ps1`や実行ポリシーの全体変更を使わない。
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

## 3. プラグイン依存関係と専用Chromium

この工程も`pluginRoot`を作業ディレクトリにし、npmの確認・導入コマンドには必ず`--prefix "<pluginRoot>"`を指定する。`<pluginRoot>`は実際に読み込まれたskillから解決した絶対パスに置き換える。運用フォルダや公開リポジトリで`npm ci`を実行しない。Windowsでは以下のnpm操作で`npm`を`npm.cmd`に読み替える。

1. `npm --prefix "<pluginRoot>" ls --depth=0`でインストール済みの直接依存関係を確認する。さらにプラグインの`package.json`にある直接依存関係と、`package-lock.json`の`packages[""].dependencies`の宣言が一致することを確認する。`npm ls`だけではlockfileとmanifestの整合性は確認できない。
2. `node ./scripts/check-dependencies.mjs`も実行する（`npm --prefix "<pluginRoot>" run check:dependencies`でも実行できる）。この確認は現在の`pluginRoot/node_modules`内の直接依存のpackage.jsonがすべてあることを確かめ、MCPサーバーと診断スクリプトが使う実際の依存関係entrypointを、サーバーを起動せずにimportする。MCP Appsのブラウザ用バンドルはimportせず、解決と読み取り可能性だけを確かめる。結果には安全なカテゴリ、package名、entrypoint、error codeだけが出る。Windowsでは`npm.cmd`を使う。`npm`または`npm.cmd`がPATHにない場合は、公式Node.js導入先の絶対パスで`npm.cmd`を呼び、カレントディレクトリを正確な`pluginRoot`にする。Codexが使う`node`とnpm側のNode.jsが異なる場合は、同じスクリプトをCodex側の`node`と、選んだ`npm.cmd`の隣にある`node.exe`の両方で実行し、両方の結果を確認する。
3. 依存関係が欠けている、無効な依存関係がある、manifestとlockfileの宣言が食い違う、または実際のimport確認が失敗した場合は、同じ`pluginRoot`を指定した`npm --prefix "<pluginRoot>" ci`を一度実行して再確認する。ただし、同じ`pluginRoot`と現在のlockfileで`npm ci`が既に成功しており、現在もその`node_modules`内に直接依存のpackage.jsonがすべて存在する場合は、繰り返し実行せず、両Node.jsで出た安全なentrypointとerror codeを比べる。診断の`packageManifestPresent: false`と`ERR_MODULE_NOT_FOUND`は現在のキャッシュからSDKを解決できていないことを示す。チェックの`<package>/package.json: ENOENT`で欠落を確認した場合は過去の成功を適用せず、診断を実行したプラグインルートが現在のskillの`pluginRoot`と同じかローカルで照合してから、その場所へ導入する。権限エラー`EACCES`や`EPERM`の場合は欠落と扱わず止める。キャッシュの更新・置換後は再確認する。依存関係・lockfile確認と実際のimport確認がすべて成功していれば`npm ci`は実行しない。`npm ci`は`node_modules`を作り直し、lockfileに従って依存関係を取得し、postinstallでChromiumを導入することがある。セットアップ中のソフトウェア導入と必要な外部通信を利用者が既に承認している場合、その承認を再度求めず実行する。まだ承認されていない場合は、実行前にnpmパッケージ取得を含む導入承認を得る。
4. `npm ci`が成功したら、`npm --prefix "<pluginRoot>" ls --depth=0`、manifest・lockfileの宣言、実際のimport確認を再実行する。いずれかが失敗した場合は成功扱いにせず、表示された安全なカテゴリとentrypoint、error codeを示して止める。`npm ci`自体が失敗した場合も成功扱いにしない。失敗がChromiumのpostinstallだけで、依存関係、lockfile、実際のimport確認は有効だと確認できた場合に限り、次の専用Chromium手順を使う。
5. `playwright-core`のPlaywright APIで`chromium.executablePath()`を取得して実行ファイルの存在を確認し、`chromium.launch({ headless: true })`と`browser.close()`が成功することを確認する。依存関係が有効なのにChromiumだけが無い場合は、`pluginRoot`で次を一度実行する。`npm ci`でChromiumまで利用可能になった場合はこのインストールを繰り返さない。

```sh
node ./node_modules/playwright-core/cli.js install chromium
```

Chromium導入後、同じPlaywright APIで実行ファイルと起動を検証する。失敗した場合は認証へ進まず、原因を示して止める。`npm ci`やChromiumの導入をした後、または依存関係不足でMCPツールが使えなかった場合は、Codexアプリを完全終了して再起動する。その後、同じ初回設定チャットを再開して「`$zawazawa-setup`で初回設定を再開」と依頼する。作成済みの運用フォルダをローカル環境として使う。アプリの都合で新しいローカルタスクが必要な場合はそのフォルダを開いて開始するが、以前承認された差分を正確に確認できなければ既存の停止条件に従う。依存関係を入れたアプリの再起動前にMCPツールを探したり呼び出したりしない。

## 4. 認証と読み取り確認

依存関係の確認後、必要なアプリ再起動が終わってから初めて、現在のプラグインが提供するMCPツールを確認する。ツールが見つからない場合は存在を仮定せず止める。

1. `pluginRoot`で`npm run auth:zawazawa -- <グループキー>`を実行する。
2. 開いた専用ブラウザで、利用者本人にログインと対象グループの確認をしてもらう。Cookie、パスワード、トークンを会話へ貼らせない。
3. 運用フォルダにある`zawazawa.config.json`の絶対パスを`get_moderation_target_config`へ渡し、表示名、グループキー、`restricted`を読み戻す。
4. 認証済みの読み取り専用入口で接続を確認する。通報への変更、一覧判断の送信、実行ツールは呼ばない。

完了時は、作成したフォルダ、テンプレート、対象、`restricted`、認証・接続の結果を示す。次は運用フォルダをローカルプロジェクトとして開いたタスクから`$zawazawa-moderation`を使うよう案内する。Claude Codeの既存利用者には`/zawazawa-moderation-review:zawazawa-moderation`も案内する。特に追加の指示がなければ、未処理のZAWAZAWA通報を調べる挙動になると説明する。
