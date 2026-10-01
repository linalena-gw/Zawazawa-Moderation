# ZAWAZAWA Moderation Review

ZAWAZAWA掲示板の管理人に向けた、通報処理お助けツールです。Codex / Claude Code向けのローカルプラグインで、未処理通報を調査し、Wikiごとの運用基準に沿った対処案を作成・実行します。

開発者は原神wiki2代目管理人です。引退の間際に試作したもので、今後の保守・更新予定はございません。また、ZAWAZAWA・Wikiwiki公式に何らの許諾も得ていません。自己責任において自由に改変・使用してください。日々の通報対応の負担が少しでも減りますよう。

## 何ができるの？

1. Codex内で``/zawazawa-moderation-review``と打つだけで、全件の通報を取得します。通報されたコメントについて、同じツリーのコメントと、過去の投稿履歴が一画面で見られます。文脈を追う＋常習性を確認するという作業に手間がなくなります。初回のみ`/zawazawa-setup`で初期設定を行ってください。
2. 取得した通報に対し、AIが対処案（削除、削除＋規制、何もしない）を作成します。対処案を修正するか、そのまま承認すれば実行までAIが担ってくれます。
3. 対処案は「運用基準」という単一の文書に基づいて作られます。この文書は原神wikiの慣行が元になっていますが、自由にカスタマイズ可能です。
4. AI対処案と違う判断を人間が下した際は、それに沿って基準を修正し（ユーザーも介入可能です）、修正後の基準と該当のコメントを独立したサブエージェントに投げて、修正の効力を検証します。
5. 対処案作成→即実行のモードもあります。運用基準が熟してきたらこのモードに切り替え、Codexで定期実行すれば手間いらずで通報対応が可能です。

## 注意点・限界

1. いわゆるVibe Coding Shitです。開発者はコードを1行も書いていません。SKILL.mdやreferencesはかなり手を入れましたが、設計上の良し悪しはわかっていません。とりあえず動くからヨシ！として公開に踏み切っています。
2. 基準を自己修正する機能はあまり試せていません。この機能がきちんと動き始めた時には、もう運用基準がまとまりきっていたので。

## 対応環境

- macOSまたはWindowsのPC
- Codexデスクトップ、またはローカルファイルとコマンドを扱えるClaude Code環境
- Node.js 24 LTS。未導入の場合は`$zawazawa-setup`が公式インストーラーによる導入を案内します
- 対象ZAWAZAWAグループの管理権限

PCを持たない場合、Web・モバイルだけの場合、Linuxは対応していません。

## Codexへインストール

Codexへ次のまま依頼できます。

> GitHubの`linalena-gw/Zawazawa-Moderation`をプラグインマーケットプレイスとして追加し、`zawazawa-moderation-review`をインストールして。インストール後に新しいタスクで`$zawazawa-setup`を使える状態まで確認して。

手動の代替手順では、まずマーケットプレイスを追加します。

```text
codex plugin marketplace add linalena-gw/Zawazawa-Moderation
codex plugin marketplace list
```

続いてCodexデスクトップを再読み込みし、プラグインディレクトリで`ZAWAZAWA Moderation`を選び、`zawazawa-moderation-review`をインストールします。新しいタスクを開始し、`$zawazawa-setup`を呼びます。Codexのマーケットプレイス仕様は[OpenAI公式ドキュメント](https://developers.openai.com/ja-JP/plugins/build/plugins)を参照してください。

## Claudeへインストール

Claude Codeでは、次の二行をClaude Code内で入力します。GitHubからマーケットプレイスを追加し、詳細画面でインストール範囲を確認できます。

```text
/plugin marketplace add linalena-gw/Zawazawa-Moderation
/plugin install zawazawa-moderation-review@zawazawa-moderation
```

新しいセッションで`/zawazawa-moderation-review:zawazawa-setup`を入力するか、`/`から同梱skillを選びます。Claude Codeの[マーケットプレイス公式手順](https://code.claude.com/docs/en/plugin-marketplaces)を参照してください。

## 初回設定

初回設定skillは、Codexでは`$zawazawa-setup`、Claude Codeでは`/zawazawa-moderation-review:zawazawa-setup`を使って次を行います。

1. OS、Node.js、npm、依存関係、専用Chromiumを確認
2. 同梱の統一運用基準テンプレートを初期案として提示
3. 専用のWiki運用フォルダを作成
4. 管理画面URLと表示名から`restricted`設定を生成
5. 運用基準を確認し、対象Wikiに必要な修正だけを承認後に反映
   テンプレは[ZAWAZAWA利用規約 第6条](https://z.wikiwiki.jp/s/agreement)と[WIKIWIKI 本サービスに関する利用のルール](https://wikiwiki.jp/pp/rules)を基礎に、著者の原神Wiki由来の慣行を加えた初期案です。対象Wikiに合わせて編集してください。
6. 専用ブラウザで管理者本人がログイン
7. 対象設定と読み取り専用接続を確認

## 通常の使い方

初回設定後は、生成された運用フォルダを開いたタスクで調査skillを実行します。Codexでは`$zawazawa-moderation`、Claude Codeでは`/zawazawa-moderation-review:zawazawa-moderation`を呼ぶか、「未処理のZAWAZAWA通報を調べて」と依頼してください。

初期モードは`restricted`です。skillが読み取り専用で通報と文脈を調べて一覧を作り、管理者が案件ごとの判断を確認して送信します。送信後に元の会話へ戻り、「送信済み」と伝えて一覧のバッチを実行し、結果報告で成功・保留・結果不明を確認します。

全案件をエージェントが判断・実行する`autonomous`は、対象設定で明示的に選んだ場合だけ使えます。権限の意味と変更手順は[プラグインの運用モード説明](./plugins/zawazawa-moderation-review/README.md#対象グループの設定)を確認してください。

## 困ったとき

- skillが見つからない場合は、Codex/Claudeを再起動して新しいタスクまたはセッションで呼び直します。
- 依存関係や専用Chromiumが無い場合は、初回設定skillを再実行して環境確認からやり直します。
- 認証が切れた場合は、専用ブラウザで管理者本人の再認証を行ってから調査を再開します。

## 安全とプライバシー

- 認証は専用ブラウザプロファイルにだけ保存し、普段使いのブラウザからCookieを取得しません。
- 通報者を識別する表示、接続元情報、認証情報は保存・表示しません。
- 一覧での判断、実行許可、実際の送信、成功確認を分離します。
- 結果報告には投稿本文と通報理由が含まれるため、Git管理・共有しません。

詳細は[プラグインの設定と利用](./plugins/zawazawa-moderation-review/README.md)と[SECURITY.md](./SECURITY.md)を参照してください。

## 変更する場合

プラグイン本体を変更する場合の導入、プレビュー、テスト、検証は[プラグインREADMEの開発節](./plugins/zawazawa-moderation-review/README.md#開発)を参照してください。

## License

[MIT License](./LICENSE)
