# AGENTS.md

このリポジトリは、ZAWAZAWA掲示板の通報対応プラグインを配布するための公開ツリーである。プラグイン本体は`plugins/zawazawa-moderation-review/`、Wikiごとの初期文書は`plugins/zawazawa-moderation-review/skills/zawazawa-setup/assets/`にある。

リポジトリルートを実運用フォルダとして使わない。実運用の`zawazawa.config.json`、運用基準、判断事例、結果報告、認証情報は公開ツリーへ置かず、セットアップで作成した専用フォルダに保存する。

コードやskillを変更するときは、同じ内容を別の文書へ複製せず、関係するテストと`plugins/zawazawa-moderation-review`の`npm run verify`で確認する。初期テンプレートは対象Wikiに合わせて利用者が確認・編集する。

通報者の表示名とトリップ、接続元情報、通信先の内部情報、User-Agent、セッション、Cookie、パスワード、トークン、実データをテスト、テンプレート、判断事例、公開文面、Git履歴へ書かない。
