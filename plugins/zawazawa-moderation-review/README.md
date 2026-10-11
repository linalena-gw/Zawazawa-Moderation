# zawazawa-moderation-review — 設定と利用

ZAWAZAWAの通報を読み取り、実行先Wikiの運用基準に沿った対処案を一覧で確認し、承認済みの操作だけを実行するローカルプラグインです。一覧の表示だけではZAWAZAWAを変更しません。初回設定と通常処理の手順は、それぞれ同梱skillの正本に従います。

この文書は、ホストへの導入が済んだ後の設定と運用を説明します。プラグイン自体を変更する場合は、末尾の「開発」を参照してください。

## 使い始める

Codexデスクトップでのプラグイン導入と専用フォルダの用意は、[リポジトリのREADME](../../README.md)を参照してください。この文書は、プラグインをインストールして有効にした後の設定と利用を説明します。

専用の空フォルダをCodexでローカルプロジェクトとして開き、新しいチャットで`$zawazawa-setup`を呼びます。セットアップはNode.js 24 LTS、npm、lockfileの依存関係、専用Chromiumを確認し、不足している依存関係とChromiumを必要な場合に導入します。その後、`restricted`モードの設定と運用基準を作り、専用ブラウザで管理者本人がログインして読み取り専用接続を確認します。完了を確認するまでは通報の対処を始めないでください。

依存関係の導入には`npm ci`を使います。詳細な停止条件と、運用基準テンプレートを対象Wikiに合わせて確認・編集する手順は[`zawazawa-setup`の手順](./skills/zawazawa-setup/references/setup-flow.md)を参照してください。

再認証が必要な場合は、プラグインディレクトリで次を実行し、専用ブラウザでログインして対象グループを確認します。普段使うブラウザのCookieは使いません。

```bash
npm run auth:zawazawa -- <グループキー>
```

## 対象グループの設定

セットアップで作る運用フォルダのルートに`zawazawa.config.json`を置き、対象グループと表示名を宣言します。設定しないままでは読み取りと一覧作成を始めません。

```json
{
  "version": 4,
  "target": {
    "groupKey": "example-wiki",
    "displayName": "サンプルWiki"
  },
  "moderation": {
    "mode": "restricted"
  }
}
```

`groupKey`は`https://z.wikiwiki.jp/<グループキー>/`のグループキーです。管理画面URLや公開URLを設定へ書きません。`displayName`は一覧と報告の表示にだけ使います。運用基準は設定へ埋め込まず、運用フォルダ直下の固定名`運用基準.md`を正本にします。`根拠資料.md`と`判断事例.md`は基準を見直す場合だけ使います。

### 運用モード

| モード | 判断と実行許可 | 一覧 |
| --- | --- | --- |
| `restricted` | 管理者が一覧で判断を送信 | すべての案件を提示 |
| `autonomous` | エージェントが全案件を判断 | 承認画面を提示しない |

初回設定は常に`restricted`です。`autonomous`は対象設定で明示的に選んだ場合だけ使い、案件ごとに判断主体を切り替える設定はありません。どちらのモードでも対象の束縛、完全案の解決、実行直前の照合、実行ジャーナル、保存禁止情報の扱いは同じです。

設定は`version: 4`と`restricted`または`autonomous`のモードを要求し、未知のキーを無視しません。変更後に対象コンテキストを自動で束縛し直さず、skillの手順に従って再開します。

### 対象の束縛

skillは最初に実行先リポジトリのルートで設定ファイルを見つけ、絶対パスを`get_moderation_target_config`の`configPath`へ渡します。返された`targetContextId`を以降の読み取りと一覧作成へそのまま渡してください。ツールはグループキーを直接受け付けず、束縛した設定と異なる対象を`group_not_allowed`として止めます。束縛後にグループまたはモードを変更した場合も停止し、設定を確認してから新しい一覧を作ります。

## 実行時設定

必要な場合だけ環境変数で既定値を上書きします。保存先は運用フォルダ内へ置きません。

| 設定 | 用途 |
| --- | --- |
| `ZAWAZAWA_TARGET_CONFIG` | 対象設定の絶対パス。ファイル名は`zawazawa.config.json`に固定。 |
| `ZAWAZAWA_REVIEW_STORE_DIR` | 一覧、承認、実行ジャーナルの保存先。macOSは`~/Library/Application Support/ZAWAZAWA Moderation Review/reviews`、Windowsは`%LOCALAPPDATA%\ZAWAZAWA Moderation Review\reviews`。 |
| `ZAWAZAWA_REVIEW_UI_PORT` | ループバックUIへ渡す固定ポート。未指定時は空きポート。 |
| `ZAWAZAWA_REVIEW_UI=off` | `ui://`だけを使うホストでループバックUIを停止。 |
| `ZAWAZAWA_CONNECTOR_PROFILE_DIR` | 専用ブラウザのプロファイル。macOSは`~/Library/Application Support/Codex/ZAWAZAWA Moderation Connector/chrome-profile`、Windowsは`%LOCALAPPDATA%\ZAWAZAWA Moderation Review\connector-profile`。 |
| `ZAWAZAWA_CONNECTOR_HEADLESS=0` | 読み取り用ブラウザを表示ありで起動。既定はヘッドレス。 |
| `ZAWAZAWA_PUBLIC_USER_AGENT` | 公開ページreaderの識別用User-Agent。ブラウザを偽装する値は使わない。 |

正式対応はmacOSとWindowsです。その他のOSで手動検証する場合は、保存先とブラウザプロファイルを絶対パスで明示し、未対応環境として扱います。認証Cookieは専用プロファイルにだけ保存されます。

## 調査と一覧

一覧作成ツールへ渡すコメントは`topicNumber`と`commentNumber`による参照だけにします。本文、URL、現在状態、通報理由、通報ID、処理単位の表題はサーバーが参照先から解決します。完全なスナップショットを作れない場合は、手入力の本文や通報理由へフォールバックせず停止します。

MCP Appsを描画できるホストは`ui://`の一覧を使います。`window.openai`を提供するホストは同じ保存済みスナップショットとMCPツールを使い、ループバックUIを返せるホストでは`reviewUrl`を使えます。ホストがどの表示経路を提供するかで操作画面は変わりますが、`snapshotToken`を照合できるまで承認可能な一覧を表示しません。表示経路と判断回収の順序は[`review-ui.md`](./skills/zawazawa-moderation/references/review-ui.md)を参照してください。

## 承認済み操作と結果

通常は`execute_zawazawa_moderation_batch`で保存済み承認の未送信操作を上限付きで処理します。個別の再開には`execute_zawazawa_moderation_operation`、外部送信の結果が不明なときの照合には`reconcile_zawazawa_moderation_operation`を使います。送信内容や対象を実行呼び出しから受け取らず、保存済みの承認と実行直前のライブ事実を照合して決めます。結果不明の操作を推測で再送しません。

`render_moderation_report`は、判断と実行ジャーナルを突き合わせた読み取り専用HTMLを実行先の`moderation-reports/`へ書き出します。報告には投稿本文と通報理由が含まれるため、運用フォルダをGit管理・共有しないでください。

## 既知の制限

- 正式対応はmacOS・Windows上のローカル実行環境で、Node.js 24 LTSが必要です。Web・モバイルだけの環境は対象外です。
- ホストが一時状態を保持しない場合、一覧の再描画で未送信の選択が消えることがあります。判断は保存済みスナップショットに対して行います。
- ブラウザ経路が必要な操作や、管理画面を同定できない画面の確認には、ホストが提供するブラウザ操作機能が必要です。利用できない場合はその操作を送信せず停止します。
- 公開ページからコメントが消えたことだけでは、削除と投稿時の自動無視を区別できません。429・503などの一時的な制限は、間隔を置いて再試行します。

## 開発

プラグインディレクトリで依存関係を導入し、全体検証を実行します。

```bash
cd plugins/zawazawa-moderation-review
npm ci
npm run verify
```

一覧UIを変更した場合は、次のプレビューで`window.openai`経路とMCP Apps経路を確認します。

```bash
npm run preview -- --port 4173
```

`http://localhost:4173/`は`window.openai`相当、`http://localhost:4173/mcp-app`はMCP Apps相当のホストを模擬します。変更を限定して確認するときは`node --test test/<name>.test.mjs`を使い、共有基盤へ及ぶ変更やレビュー後は`npm run verify`を使います。

## コード変更時の正本

機械的な安全条件はコードを正本とし、skillやこの文書へ再定義しません。変更箇所に対応する正本を先に確認してください。

| 関心事 | 正本 |
| --- | --- |
| 対象設定と運用モード | [`server/target-config.mjs`](./server/target-config.mjs) |
| 入力項目と自由文の検査 | [`server/review-input.mjs`](./server/review-input.mjs)、[`server/input-text.mjs`](./server/input-text.mjs) |
| 完全案、代替案、承認の導出 | [`server/resolved-plan.mjs`](./server/resolved-plan.mjs)、[`server/review-authorization.mjs`](./server/review-authorization.mjs)、[`server/review-store.mjs`](./server/review-store.mjs) |
| 実行直前照合と送信 | [`server/execution-preconditions.mjs`](./server/execution-preconditions.mjs)、[`server/admin-writer.mjs`](./server/admin-writer.mjs) |
| 実行状態とジャーナル | [`server/execution-lifecycle.mjs`](./server/execution-lifecycle.mjs)、[`server/execution-journal.mjs`](./server/execution-journal.mjs) |
| 管理画面・公開ページの読み取り | [`server/admin-reader.mjs`](./server/admin-reader.mjs)、[`server/public-reader.mjs`](./server/public-reader.mjs) |
| MCPツールと一覧の表示範囲 | [`server/server.mjs`](./server/server.mjs)、[`ui/review.html`](./ui/review.html) |

モデルが守る工程と安全境界は[`zawazawa-moderation` skill](./skills/zawazawa-moderation/SKILL.md)に、初回設定は[`setup-flow.md`](./skills/zawazawa-setup/references/setup-flow.md)にあります。実行と結果照合の詳細は[`live-execution.md`](./skills/zawazawa-moderation/references/live-execution.md)、ブラウザ経路は[`browser-execution.md`](./skills/zawazawa-moderation/references/browser-execution.md)を参照してください。
