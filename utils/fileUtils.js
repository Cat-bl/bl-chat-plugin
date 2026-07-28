// fileUtils 聚合出口：实现拆至 utils/file/*，此处仅 re-export 保持既有 import 路径兼容。
export { getNapcatRKeys, isTencentImageUrlAvailable, refreshTencentImageUrl, normalizeImageUrls, getRKey, extractDomain } from "./file/tencentImage.js";
export { getFileExtensionFromUrl, downloadAndSaveFile, PluginUploadFile, getBase64Image, getBase64File, downloadImage } from "./file/download.js";
export { TakeImages, getFileInfo } from "./file/messageSource.js";
export { saveUserHistory, loadUserHistory, loadData, saveData } from "./file/history.js";
export { chunk, removeDuplicates } from "./file/collection.js";
export { get_address, getResponse, handleImages, sendLongMessage } from "./file/misc.js";
