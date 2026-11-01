# 智能体安装步骤

1. 根据正在运行的ComfyUI进程、Desktop安装记录或用户指定目录找到实际实例、Python、用户工作流目录。不要全盘扫描模型。
2. 安装到当前实例`custom_nodes/ComfyUI-Workflow-Library`，不要与同名旧插件重复注册。已有同源干净Git安装可快进更新；有本地修改时保留并合并，不执行`reset --hard`。
3. 使用当前实例Python安装`requirements.txt`，它只需要Pillow和imageio-ffmpeg。不要替换PyTorch或下载模型权重。
4. 检查插件`__init__.py`使用相对`start.ps1`，前端由`comfy_web`发布；实例内Python路径不同则设置`COMFYUI_PYTHON`。
5. 个人元数据默认`user/workflow-library`，原工作流目录默认`user/default/workflows`。特殊目录使用环境变量，不把作者路径照抄到新电脑。
6. 新装默认空收藏；不能复制作者data、分类、封面、输入输出或自用工作流。用户主动拖入、导入后才建立引用。
7. 检查8190仅本机监听、状态接口返回`comfy-workflow-library`及V1.5.0。新增插件在ComfyUI下次正常启动后生效，不结束当前运行任务。
8. 验证入口、空库、分类与导入操作；测试用临时无敏感JSON，不运行真实GPU工作流。最终报告实际路径、版本、验证结果和缺失项。
