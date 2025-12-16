import path from "path";

const packageJsonPath = path.resolve(path.join('./plugins', 'test-plugin'));

// 本地资源
export const CHECK_IMG = `${packageJsonPath}/assets/check@96x100.png`;
export const DEERPIPE_IMG = `${packageJsonPath}/assets/deerpipe@100x82.png`;
export const MISANS_FONT = `${packageJsonPath}/assets/MiSans-Regular.ttf`;
export const PLUGIN_PATH = `${packageJsonPath}`;