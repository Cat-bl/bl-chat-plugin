// 通用数组工具：分块、下载链接去重。从 fileUtils.js 拆出（行为等价搬迁）。

/**
 * 将数组分块
 * @param {Array} array - 原数组
 * @param {number} size - 每块大小
 * @returns {Array<Array>} - 分块后的二维数组
 */
export function chunk(array, size) {
  return Array.from({ length: Math.ceil(array.length / size) }, (_, index) =>
    array.slice(index * size, (index + size))
  );
}

/**
 * 移除重复链接
 * @param {Array} array - 链接数组
 * @returns {Promise<Array>} - 去重后的链接数组
 */
export async function removeDuplicates(array) {
  const result = array.filter((item, index) => {
    if (item.indexOf('/cdn/download/') == -1) {
      return true;
    } else {
      const nonDownloadUrl = item.replace('/cdn/download/', '/cdn/');
      return array.indexOf(nonDownloadUrl) == -1;
    }
  });
  return result;
}
