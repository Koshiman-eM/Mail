/**
 * コアのテストの共通の前処理: 資産クラスを crypto・meme に決める (いまの唯一のアプリ trader と同じ組。
 * 既存の試験はこの組を前提にしている)。fx・stock のプロファイルの試験はファイルの中で resetEnabledAssetClassesForTests してから選ぶ
 */
import { setEnabledAssetClasses } from "../src/core/assetClasses";

setEnabledAssetClasses(["crypto", "meme"]);
