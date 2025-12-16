import Base from './base.js'


export default class Qqinfo extends Base {
    constructor(e) {
        super(e)
        this.model = 'qqinfo'
    }

    /** 生成版本信息图片 */
    async getData(data, scale) {
        return {
            ...this.screenData,
            saveId: 'qqinfo',
            ...data,
            sys: {
                scale: this.scale(scale || 1)
            },
        }
    }

    scale(pct = 1) {
        const renderScale = 100
        const scale = Math.min(2, Math.max(0.5, renderScale / 100))
        pct = pct * scale
        return `style=transform:scale(${pct})`
    }
}
