# 初回設定手順

この手順はmacOSまたはWindowsのローカル環境向けである。Web・モバイルだけの環境やLinuxでは設定を変更せず、正式対応外と伝えて止める。対象WikiのZAWAZAWA管理画面を操作できる権限が必要だが、これはZAWAZAWA側の権限を指し、WindowsやmacOSの管理者権限を指さない。

実際に読み込まれたプラグインのネイティブbootstrapを使う。Codexユーザー設定にMCP登録が済み、ツールが見えるまではMCPツールを呼び出さない。ツール名を推測して呼んだり、別のプラグインやソースツリーで代用したりしない。

## 1. OSとプラグインの場所

1. このskillが読み込まれた実ファイルの場所を確認する。その`SKILL.md`を含むディレクトリを`skillRoot`とし、`skillRoot/../..`を実際に読み込まれたプラグインルート`pluginRoot`として解決する。両方を絶対パスにする。実行するOSに応じ、macOSでは`pluginRoot/scripts/bootstrap.sh`、Windowsでは`pluginRoot/scripts/bootstrap.ps1`を`bootstrapPath`として使う。プラグインがインストールキャッシュにあるなら、その場所が使うべき`pluginRoot`である。公開ソースの別チェックアウトへ切り替えたり、ソースツリーの依存関係を実行時に使ったりしない。実際のskillの場所を特定できない場合は止める。
2. macOSまたはWindowsのローカル環境であることと、対象Wikiの管理画面を操作できることを確認する。
3. Node.jsやnpmのシステム導入状態、PATH、npmラッパーを確認・変更しない。専用Node.jsとnpmはbootstrapが用意する。

## 2. 専用ランタイムの準備

Node.js、コードとnpm依存関係、ChromiumはCodexのプラグインキャッシュの外にある専用ホームへ置く。既定のホームはmacOSが`~/Library/Application Support/ZAWAZAWA Moderation Review`、Windowsが`%LOCALAPPDATA%\ZAWAZAWA Moderation Review`である。ホームにはピン留め済みNode.jsの`node/`、全コード版で共用するPlaywrightブラウザーの`browsers/`、版とコードのフィンガープリントごとの実行コードと依存関係の`runtimes/`が作られる。設定、運用基準、認証プロファイル、通報データ、結果報告をこのホームへ保存しない。

まず、`bootstrapPath`で準備状態を調べる。`--print-root`と`--print-node`は既存ファイルを確認するだけで、ネットワークアクセスやインストールを行わない。成功すると、`runtimeRoot`と`nodePath`の絶対パスがそれぞれ標準出力に返る。

macOS:

```sh
/bin/sh "<bootstrapPath>" --print-root
/bin/sh "<bootstrapPath>" --print-node
```

Windows PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<bootstrapPath>" -PrintRoot
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<bootstrapPath>" -PrintNode
```

Windowsの`-ExecutionPolicy Bypass`はこのPowerShellプロセスだけに適用し、システム設定は変更しない。Node.jsまたは現在のコードに一致するランタイムが未準備なら、初回のソフトウェア取得内容を説明し、ネットワーク取得の承認を得てから`--prepare`を実行する。同じ作業ですでに承認されている場合は、再度尋ねない。

macOS:

```sh
/bin/sh "<bootstrapPath>" --prepare
```

Windows PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<bootstrapPath>" -Prepare
```

bootstrapは公式Node.js v26.11.1のOS・CPU別アーカイブを固定SHA-256で検証して`node/`へ展開する。同梱npmを使い、コード版に一致するランタイムへ依存関係を準備する。続けて共用Chromiumを`browsers/`へ導入し、Playwrightから起動して検証する。準備後に再び`--print-root`と`--print-node`を実行し、パスを`runtimeRoot`と`nodePath`として使う。

同じNode.js、コード版、依存関係、共用Chromiumが準備済みなら再取得しない。コード更新で新しいフィンガープリントのランタイムが必要な場合は、その版だけを準備する。プラグインキャッシュが作り直されても、ユーザー領域の準備済みデータは再利用する。通常のMCPサーバー起動ではネットワークアクセスやインストールを行わない。

## 3. 運用フォルダと初期文書

未確定の値だけをまとめて尋ねる。

- 運用フォルダの絶対パス
- `https://z.wikiwiki.jp/m/<グループキー>/...`形式の管理画面URL
- 一覧と報告に出すWiki表示名

運用フォルダは公開リポジトリ、ソースチェックアウト、インストール済みプラグインまたはそのキャッシュの外にある専用フォルダにする。解決済みパスを使って同一場所や配下になっていないことを確かめる。Windowsでは大文字小文字を区別しない。Finderやエクスプローラーで先に作成した空のフォルダは使えるが、未管理のファイルがある場所は選ばない。`zawazawa.config.json`、運用基準、判断事例、結果報告、認証情報をソースツリー、プラグインキャッシュ、公開リポジトリへ保存しない。

同梱の統一テンプレートを初期案として使い、初期モードは`restricted`固定にする。テンプレートには著者の原神Wiki由来の慣行が含まれるため、対象Wikiに合わせて全文を確認し、節ごとの要点を利用者へ示す。利用者が修正を求めた場合は、生成前に具体的な差分を示して承認を得る。テンプレートをそのまま使うか、提示済みの差分を採用するかが確定するまで`--apply`を使わない。初回設定中に`autonomous`を提案したり、選択肢へ加えたりしない。

セットアップスクリプトは専用Node.jsで`--dry-run`を実行する。`nodePath`はbootstrapの`--print-node`から得た絶対パスを使う。以下は一行のコマンド例で、`<...>`部分は実際の値に置き換える。`nodePath`、`skillRoot`を含む各パスと値は一つの引数としてシェルの規則で引用し、引用符を含む値では区切り文字を正しくエスケープする。PowerShellの単一引用符内では`'`を`''`と書く。macOSのzshでは単一引用符内の`'`を`'\''`の形でエスケープする。値をコマンド文字列として評価・展開しない。

Windows PowerShell:

```powershell
& '<nodePath>' '<skillRoot>\scripts\init-workspace.mjs' --destination '<絶対パス>' --admin-url '<管理画面URL>' --display-name '<Wiki表示名>' --dry-run
```

macOS zsh:

```sh
'<nodePath>' '<skillRoot>/scripts/init-workspace.mjs' --destination '<絶対パス>' --admin-url '<管理画面URL>' --display-name '<Wiki表示名>' --dry-run
```

再開時も`--dry-run`を省略しない。編集済みの`運用基準.md`はスクリプトから`preserve`として報告されるが、これは承認済みの差分を意味しない。前回の承認済み編集と現在の差分が一致し、固定名の生成物がすべて揃い、設定が`restricted`であることを別途確認できた場合に限り次の工程へ進む。承認内容を確認できない場合、未管理の項目、生成物の不足、その他の内容差分が一つでもある場合は、再開済みと推測せず止める。

返されたファイル一覧、抽出したグループキー、統一テンプレート、`restricted`で作ることを示す。衝突があれば上書きせず、そのファイルと理由を伝える。`skillRoot/assets/templates/運用基準.md`を全文読み、節ごとの要点を示す。テンプレートをそのまま使うか、利用者が承認した具体的な差分を採用することが確定した後に限り、同じ引数で`--apply`を実行する。

生成後の運用フォルダにある`運用基準.md`を全文読み戻す。利用者が提示済みの差分を採用すると決めた場合は、そのファイルだけへ反映して再び全文読み戻す。他の生成ファイルへ承認を流用しない。生成物に認証情報を入れない。`根拠資料.md`と空の`判断事例.md`は基準保守時だけ使い、通常の通報対応では読まない。

## 4. Codex登録、認証、読み取り確認

運用フォルダの生成と読み戻しが完了したら、bootstrapの`--run-script register`でCodexユーザー設定へMCPサーバーを登録する。Codex設定のMCP登録だけを追加・更新し、他の設定と無関係なMCP登録は保持する。同じサーバー名の既存設定が手動登録など管理対象外の場合は、上書きせず競合エラーで停止する。

macOS:

```sh
/bin/sh "<bootstrapPath>" --run-script register
```

Windows PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<bootstrapPath>" -RunScript register
```

登録結果のJSONを確認する。`status`が`registered`なら登録内容が変わったため、Codexを再起動して同じチャットを再開し、MCPツールが実際に見えることを確認する。`unchanged`なら再起動は不要。競合や登録失敗が起きた場合は既存設定を変更せず、理由を利用者に示して止める。PATH変更のために再起動しない。

プラグインをアンインストールし、MCP登録も削除するよう明示的に頼まれた場合は、プラグインを無効化・アンインストールする前に、bootstrapの`--run-script unregister`を実行する。これはこのプラグインが管理するMCP登録だけを削除する。`not_registered`なら削除対象がないことを伝える。プラグイン自体のアンインストールではCodexユーザー設定の登録は自動削除されない。

macOS:

```sh
/bin/sh "<bootstrapPath>" --run-script unregister
```

Windows PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<bootstrapPath>" -RunScript unregister
```

MCPツールが読み込まれた後に、認証が必要ならbootstrap経由で専用ブラウザを開く。

macOS:

```sh
/bin/sh "<bootstrapPath>" --run-script auth "<グループキー>"
```

Windows PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<bootstrapPath>" -RunScript auth -ScriptArgument "<グループキー>"
```

開いた専用ブラウザで利用者本人にログインと対象グループの確認をしてもらう。Cookie、パスワード、トークンを会話へ貼らせない。認証後、運用フォルダにある`zawazawa.config.json`の絶対パスを`get_moderation_target_config`へ渡し、表示名、グループキー、`restricted`を読み戻す。認証済みの読み取り専用入口で接続を確認する。通報への変更、一覧判断の送信、実行ツールは呼ばない。

MCPツールが見つからない場合は存在を仮定せず、bootstrapの`--run-script diagnose`を使って登録・ランタイム状態を確認する。依存関係やChromiumを直すために通常起動からネットワーク取得しない。必要な準備を行う場合は、ランタイム準備の工程へ戻る。

## 5. 更新と再開

再開時は、実際に読み込まれたskillとbootstrapの場所を再解決し、`--print-root`、`--print-node`で現在の準備状態を確認する。新しいコード版用ランタイムが必要なら、その依存関係だけを準備する。準備済みNode.jsと共用Chromiumは再利用する。その後`register`を実行し、結果が`registered`のときだけCodexを再起動して同じチャットを再開する。`unchanged`ならそのまま続ける。認証が有効なら再ログインを要求しない。

完了時は作成したフォルダ、テンプレート、対象、`restricted`、認証・接続の結果を示す。次は運用フォルダをローカルプロジェクトとして開いたタスクから`$zawazawa-moderation`を使うよう案内する。特に追加の指示がなければ、未処理のZAWAZAWA通報を調べる挙動になると説明する。
