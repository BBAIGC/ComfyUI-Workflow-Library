
import {renderTextCover,animateTextCover} from './text-cover.js';
const items=[
{title:'SeedVR2无损放大',subtitle:''},
{title:'反推生图',subtitle:'Z-Image／Qwen 2.1'},
{title:'小陈生图工作台',subtitle:'Qwen 2.1／Turbo／MOSS／GPT Image／Z-Image／Krea 2'},
{title:'小陈H3多分镜工作台',subtitle:'MiniMax H3'},
{title:'MOSS写实工作台',subtitle:'Jib V2'},
{title:'图像修复与放大',subtitle:'Qwen 2.1／SeedVR2／VOSR2／DLSS5'}
];
for(const item of items){const card=document.createElement('section'),tile=document.createElement('div'),label=document.createElement('div');tile.className='demo-tile';label.className='demo-label';label.textContent=item.title;card.append(tile,label);document.querySelector('#covers').append(card);renderTextCover(tile,item);}

const replay=document.createElement("button");replay.textContent="重播动画";replay.style.cssText="margin:0 0 24px;padding:8px 14px;border:1px solid #555;background:#282828;color:#eee;border-radius:4px;font:inherit;cursor:pointer";document.querySelector("h1").after(replay);replay.onclick=()=>{document.querySelectorAll(".demo-tile").forEach((tile,index)=>setTimeout(()=>animateTextCover(tile),index*35));};
