# ComfyUI 工作流库 V1.5.0

ComfyUI里的快捷收藏工作区：主动收录常用工作流，按分类浏览、搜索和设置封面，双击在原生标签里打开。工具在画布区域铺满显示，保留顶部工具栏与工作流标签。

**公开包只提供工具源码，不包含作者的工作流、收藏分类数据、封面或生成素材。新安装默认空白，不会自动收藏名称带Codex的文件。**

## 功能

- 从原生工作流列表拖入收藏，也可导入工作流JSON；单击选择，双击打开，已打开标签优先复用。
- 分类、多分类引用、搜索、批量选择与跨分类复制；从库中移出仅取消收藏，不删除原工作流。
- 图片、短视频、文字封面和原工作流图分开保存；可以切回原图，不覆盖用户上传媒体。
- 内嵌工作流预览支持缩放和平移；左下角版本入口打开关于与更新链接。
- 所有库数据放当前实例`user/workflow-library`，原工作流仍在`user/default/workflows`，代码更新与个人收藏分离。

## 智能体安装 · 复制即用

```text
请安装 ComfyUI 工作流库。
仓库：https://github.com/BBAIGC/ComfyUI-Workflow-Library
先读README.md、AGENT_INSTALL.md和release.json，自动识别当前使用的ComfyUI实例与Python，保留原工作流、收藏、分类和封面。将工具安装到custom_nodes/ComfyUI-Workflow-Library，安装requirements.txt，不替换已工作的PyTorch，不另建第二份同名插件。公开包不含任何作者工作流，默认空库。依照说明检测启动路径、8190本机服务和左栏入口；只有新增后端节点需要下次正常重启时告诉我，不结束正在执行的任务。完成后报告实际版本、位置和真实验证结果。
```

## 手动安装

在当前实例的`custom_nodes`目录克隆：

```powershell
git clone https://github.com/BBAIGC/ComfyUI-Workflow-Library.git
& '当前实例python.exe' -m pip install -r '.\ComfyUI-Workflow-Library\requirements.txt'
```

插件应与其他自定义节点同级。新增插件在ComfyUI下次正常启动后加载；点击左栏“工作流库”打开。独立预览可运行`start.ps1`，本机地址为`http://127.0.0.1:8190`。

Desktop和便携版启动脚本优先使用实例内的Python；不在标准位置时可设置：

```powershell
$env:COMFYUI_PYTHON = '当前实例python.exe'
$env:COMFYUI_WORKFLOWS_DIR = '原工作流目录'
$env:WORKFLOW_LIBRARY_DATA_DIR = '个人库数据目录'
```

工具不读取其他软件密钥，库服务只监听本机。首次打开为空，在界面主动拖入或导入需要的工作流即可。

## 更新与数据

从[Releases](https://github.com/BBAIGC/ComfyUI-Workflow-Library/releases)或同来源Git仓库获取新版本。先保留个人修改，更新代码不能覆盖`user/workflow-library`。公开仓库与压缩包不应该包含`data/library.json`、分类数据、封面、输出或作者自用工作流。

视频封面需要FFmpeg，`imageio-ffmpeg`可提供本机可执行文件。图片浏览和工作流收藏本身不执行GPU推理，不调用收费生图接口。

## 联系与支持

反馈请使用[Issues](https://github.com/BBAIGC/ComfyUI-Workflow-Library/issues)，附版本和脱敏错误。以下为BBAIGC近期公开仓库原有的联系及自愿支持入口。

<table><tr><th>联系作者</th><th>微信支持</th><th>支付宝支持</th></tr><tr>
<td><img src="web/assets/wechat-contact.png" width="180" alt="联系作者"></td>
<td><img src="web/assets/wechat-support.jpg" width="180" alt="微信自愿支持"></td>
<td><img src="web/assets/alipay-support.jpg" width="180" alt="支付宝自愿支持"></td>
</tr></table>

原始软件按MIT发布。`html-to-image`组件保留其上游MIT许可证；用户导入的工作流和图片不因本工具许可证改变其归属。
