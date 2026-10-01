/**
 * 公開ページreaderの差し替え。サーバー経由のテストが実サイトへ出ないようにする。
 *
 * 一覧の表題はトピック名から組み立てるので、参照解決は処理単位ごとに公開ページを引く。
 * 実装を差し替えないと、テストがZAWAZAWAへ本物の要求を出して待つことになる。
 * 返す名前は固定で、コメント本文は持たない（処置対象は管理画面から読むため）。
 */
export const MOCK_TOPIC_NAMES = Object.freeze({ 413: "雑談/オデット" });

export function createPublicReader() {
  return {
    async readTopicName({ topicNumber }) {
      return MOCK_TOPIC_NAMES[topicNumber];
    },
    async collectComments() {
      return { comments: new Map(), pagesRead: [1], missingCommentNumbers: [] };
    },
    async isPubliclyVisible() {
      return false;
    },
  };
}
