import Base from './base.js'

export default class FriendsModel extends Base {
    constructor (e) {
        super(e)
        this.model = 'friends'
    }

    /** 生成版本信息图片 */
    async getData (friendsData, myNickName) {
        return {
            ...this.screenData,
            saveId: 'friends',
            friendsData: friendsData,
            myNickName: myNickName
        }
    }
}
