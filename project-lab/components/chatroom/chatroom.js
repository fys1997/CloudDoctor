var util = require('../../utils/util.js');
const innerAudioContext = wx.createInnerAudioContext()
innerAudioContext.onPlay(() => {
  console.log('开始播放')
})
innerAudioContext.onEnded(() => {
  console.log('播放结束')
  //播放结束，销毁该实例
  // innerAudioContext.destroy()
  // console.log('已执行destory()')
})
wx.setInnerAudioOption({ obeyMuteSwitch: false });
const FATAL_REBUILD_TOLERANCE = 10
const SETDATA_SCROLL_TO_BOTTOM = {
  scrollTop: 100000,
  scrollWithAnimation: true,
}
const recorderManager = wx.getRecorderManager()
Component({
  properties: {
    envId: String,
    collection: String,
    groupId: String,
    groupName: String,
    userInfo: Object,
    onGetUserInfo: {
      type: Function,
    },
    getOpenID: {
      type: Function,
    },
  },

  data: {
    recording: false,
    chats: [],
    textInputValue: '',
    openId: '',
    scrollTop: 0,
    scrollToMessage: '',
    hasKeyboard: false,
  },

  methods: {
    onGetUserInfo(e) {
      this.properties.onGetUserInfo(e)
    },

    getOpenID() {
      return this.properties.getOpenID()
    },

    mergeCommonCriteria(criteria) {
      return {
        groupId: this.data.groupId,
        ...criteria,
      }
    },

    async initRoom() {
      this.try(async () => {
        await this.initOpenID()

        const { envId, collection } = this.properties
        const db = this.db = wx.cloud.database({
          env: envId,
        })
        const _ = db.command

        const { data: initList } = await db.collection(collection).where(this.mergeCommonCriteria()).orderBy('sendTimeTS', 'desc').get()

        console.log('init query chats', initList)

        this.setData({
          chats: initList.reverse(),
          scrollTop: 10000,
        })

        this.initWatch(initList.length ? {
          sendTimeTS: _.gt(initList[initList.length - 1].sendTimeTS),
        } : {})
      }, '初始化失败')
    },

    async initOpenID() {
      return this.try(async () => {
        const openId = await this.getOpenID()

        this.setData({
          openId,
        })
      }, '初始化 openId 失败')
    },

    async initWatch(criteria) {
      this.try(() => {
        const { collection } = this.properties
        const db = this.db
        const _ = db.command

        console.warn(`开始监听`, criteria)
        this.messageListener = db.collection(collection).where(this.mergeCommonCriteria(criteria)).watch({
          onChange: this.onRealtimeMessageSnapshot.bind(this),
          onError: e => {
            if (!this.inited || this.fatalRebuildCount >= FATAL_REBUILD_TOLERANCE) {
              this.showError(this.inited ? '监听错误，已断开' : '初始化监听失败', e, '重连', () => {
                this.initWatch(this.data.chats.length ? {
                  sendTimeTS: _.gt(this.data.chats[this.data.chats.length - 1].sendTimeTS),
                } : {})
              })
            } else {
              this.initWatch(this.data.chats.length ? {
                sendTimeTS: _.gt(this.data.chats[this.data.chats.length - 1].sendTimeTS),
              } : {})
            }
          },
        })
      }, '初始化监听失败')
    },

    onRealtimeMessageSnapshot(snapshot) {
      console.warn(`收到消息`, snapshot)

      if (snapshot.type === 'init') {
        this.setData({
          chats: [
            ...this.data.chats,
            ...[...snapshot.docs].sort((x, y) => x.sendTimeTS - y.sendTimeTS),
          ],
        })
        this.scrollToBottom()
        this.inited = true
      } else {
        let hasNewMessage = false
        let hasOthersMessage = false
        const chats = [...this.data.chats]
        for (const docChange of snapshot.docChanges) {
          switch (docChange.queueType) {
            case 'enqueue': {
              hasOthersMessage = docChange.doc._openid !== this.data.openId
              const ind = chats.findIndex(chat => chat._id === docChange.doc._id)
              if (ind > -1) {
                if (chats[ind].msgType === 'image' && chats[ind].tempFilePath) {
                  chats.splice(ind, 1, {
                    ...docChange.doc,
                    tempFilePath: chats[ind].tempFilePath,
                  })
                } else chats.splice(ind, 1, docChange.doc)
              } else {
                hasNewMessage = true
                chats.push(docChange.doc)
              }
              break
            }
          }
        }
        this.setData({
          chats: chats.sort((x, y) => x.sendTimeTS - y.sendTimeTS),
        })
        if (hasOthersMessage || hasNewMessage) {
          this.scrollToBottom()
        }
      }
    },

    async onConfirmSendText(e) {
      this.try(async () => {
        if (!e.detail.value) {
          return
        }

        const { collection } = this.properties
        const db = this.db
        const _ = db.command

        const doc = {
          _id: `${Math.random()}_${Date.now()}`,
          groupId: this.data.groupId,
          avatar: this.data.userInfo.avatarUrl,
          nickName: this.data.userInfo.nickName,
          msgType: 'text',
          textContent: e.detail.value,
          sendTime: new Date(),
          sendTimeTS: Date.now(), // fallback
        }

        this.setData({
          textInputValue: '',
          chats: [
            ...this.data.chats,
            {
              ...doc,
              _openid: this.data.openId,
              writeStatus: 'pending',
            },
          ],
        })
        this.scrollToBottom(true)

        await db.collection(collection).add({
          data: doc,
        })

        this.setData({
          chats: this.data.chats.map(chat => {
            if (chat._id === doc._id) {
              return {
                ...chat,
                writeStatus: 'written',
              }
            } else return chat
          }),
        })
      }, '发送文字失败')
    },

    //发送语音
    async onAudio(e) {
      this.setData({
        recording: true
      })
      const options = {
        duration: 5000, //指定录音的时长，单位 ms，最大为10分钟（600000），默认为1分钟（60000）
        sampleRate: 16000, //采样率
        numberOfChannels: 1, //录音通道数
        encodeBitRate: 96000, //编码码率
        format: 'mp3', //音频格式，有效值 aac/mp3
        frameSize: 50, //指定帧大小，单位 KB
      }
      //开始录音
      recorderManager.start(options);
      recorderManager.onStart(() => {
        console.log('。。。开始录音。。。')
      });
    },
    async offAudio() {
      this.setData({
        recording: false
      })
      console.log('。。。停止录音了。。。')
      recorderManager.stop();
      recorderManager.onStop((res) => {
        console.log('录音文件', res.tempFilePath)
        this.setData({
          tempFilePathrecord: res.tempFilePath
        })
        this.sendrecord()
      })
    },
    async playAudio(e) {
      console.log('点击了播放')
      var tempsound = e.currentTarget.dataset.file
      var arr = []
      arr.push(tempsound)
      console.log(arr)
      
      wx.cloud.downloadFile({
        fileID: tempsound, //音频文件url              
        success: res => {
          wx.cloud.getTempFileURL({
            fileList: arr,
            success: res => {
              console.log(res)

              innerAudioContext.autoplay = true
              innerAudioContext.src = encodeURI(res.fileList[0].tempFileURL)

              console.log(innerAudioContext.src)
              
              innerAudioContext.play()
              
            },
            fail: err => {
              console.log('播放错误', err)
            }
          })
          console.log(res.tempFilePath)
        }
        , fail(e) {
          console.log(e)
        }
      });
    },
    async sendrecord(e){
      const { envId, collection } = this.properties
      const doc = {
        _id: `${Math.random()}_${Date.now()}`,
        groupId: this.data.groupId,
        avatar: this.data.userInfo.avatarUrl,
        nickName: this.data.userInfo.nickName,
        msgType: 'record',
        sendTime: util.formatTime(new Date()),
        sendTimeTS: Date.now(), // fallback
      }

      this.setData({
        chats: [
          ...this.data.chats,
          {
            ...doc,
            _openid: this.data.openId,
            tempFilePath: this.data.tempFilePathrecord,
            writeStatus: 0,
          },
        ]
      })
      this.scrollToBottom(true)

      const uploadTask = wx.cloud.uploadFile({
        cloudPath: `Audio/${this.data.groupId}/${this.data.userInfo.nickName}/${Math.random()}_${Date.now()}.${this.data.tempFilePathrecord.match(/\.(\w+)$/)[1]}`,
        // cloudPath: 'record.mp3',
        filePath: this.data.tempFilePathrecord,
        config: {
          env: envId,
        },
        success: res => {
          this.try(async () => {
            await this.db.collection(collection).add({
              data: {
                ...doc,
                recordID: res.fileID,
              },
            })
          }, '发送录音失败')
        },
        fail: e => {
          this.showError('发送录音失败', e,'','')
        },
      })

      uploadTask.onProgressUpdate(({ progress }) => {
        this.setData({
          chats: this.data.chats.map(chat => {
            if (chat._id === doc._id) {
              return {
                ...chat,
                writeStatus: progress,
              }
            } else return chat
          })
        })
      })

    },

    async onChooseImage(e) {
      wx.chooseImage({
        count: 1,
        sourceType: ['album', 'camera'],
        success: async res => {
          const { envId, collection } = this.properties
          const doc = {
            _id: `${Math.random()}_${Date.now()}`,
            groupId: this.data.groupId,
            avatar: this.data.userInfo.avatarUrl,
            nickName: this.data.userInfo.nickName,
            msgType: 'image',
            sendTime: new Date(),
            sendTimeTS: Date.now(), // fallback
          }

          this.setData({
            chats: [
              ...this.data.chats,
              {
                ...doc,
                _openid: this.data.openId,
                tempFilePath: res.tempFilePaths[0],
                writeStatus: 0,
              },
            ]
          })
          this.scrollToBottom(true)

          const uploadTask = wx.cloud.uploadFile({
            cloudPath: `${this.properties.groupId}/${Math.random()}_${Date.now()}.${res.tempFilePaths[0].match(/\.(\w+)$/)[1]}`,
            filePath: res.tempFilePaths[0],
            config: {
              env: envId,
            },
            success: res => {
              this.try(async () => {
                await this.db.collection(collection).add({
                  data: {
                    ...doc,
                    imgFileID: res.fileID,
                  },
                })
              }, '发送图片成功')
            },
            fail: e => {
              console.log(cloudPath)
              this.showError('发送图片失败', e)
            },
          })

          uploadTask.onProgressUpdate(({ progress }) => {
            this.setData({
              chats: this.data.chats.map(chat => {
                if (chat._id === doc._id) {
                  return {
                    ...chat,
                    writeStatus: progress,
                  }
                } else return chat
              })
            })
          })
        },
      })
    },

    onMessageImageTap(e) {
      wx.previewImage({
        urls: [e.target.dataset.fileid],
      })
    },

    scrollToBottom(force) {
      if (force) {
        console.log('force scroll to bottom')
        this.setData(SETDATA_SCROLL_TO_BOTTOM)
        return
      }

      this.createSelectorQuery().select('.body').boundingClientRect(bodyRect => {
        this.createSelectorQuery().select(`.body`).scrollOffset(scroll => {
          if (scroll.scrollTop + bodyRect.height * 3 > scroll.scrollHeight) {
            console.log('should scroll to bottom')
            this.setData(SETDATA_SCROLL_TO_BOTTOM)
          }
        }).exec()
      }).exec()
    },

    async onScrollToUpper() {
      if (this.db && this.data.chats.length) {
        const { collection } = this.properties
        const _ = this.db.command
        const { data } = await this.db.collection(collection).where(this.mergeCommonCriteria({
          sendTimeTS: _.lt(this.data.chats[0].sendTimeTS),
        })).orderBy('sendTimeTS', 'desc').get()
        this.data.chats.unshift(...data.reverse())
        this.setData({
          chats: this.data.chats,
          scrollToMessage: `item-${data.length}`,
          scrollWithAnimation: false,
        })
      }
    },

    async try(fn, title) {
      try {
        await fn()
      } catch (e) {
        this.showError(title, e)
      }
    },

    showError(title, content, confirmText, confirmCallback) {
      console.error(title, content)
      wx.showModal({
        title,
        content: content.toString(),
        showCancel: confirmText ? true : false,
        confirmText,
        success: res => {
          res.confirm && confirmCallback()
        },
      })
    },
  },

  ready() {
    global.chatroom = this
    this.initRoom()
    this.fatalRebuildCount = 0
  },
})
