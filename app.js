import { createClient } from "https://esm.sh/@supabase/supabase-js@2.105.0";
const SUPABASE_URL="https://riydudeuprhygldpqsiw.supabase.co";
const SUPABASE_PUBLISHABLE_KEY="sb_publishable_P1DfLEvSt-jo-vFx16qLoQ_-g7-JfRK";
const supabase=createClient(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
const $=id=>document.getElementById(id);
const MAX_FILE_BYTES=100*1024*1024;
const ALLOWED_MIME_TYPES=new Set(["image/jpeg","image/png","image/webp","image/heic","image/tiff","video/mp4","video/quicktime","video/webm","audio/mpeg","audio/wav","audio/mp4","audio/ogg","audio/flac"]);
let guestReady=false;
function toast(message){$("toast").textContent=message;$("toast").classList.add("show");setTimeout(()=>$("toast").classList.remove("show"),3300)}
function escapeHtml(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function setProgress(label,pct){const modal=$("uploadProgressModal"),panel=$("progressWrap");modal?.classList.add("is-open");modal?.setAttribute("aria-hidden","false");panel.classList.remove("hidden");$("closeUploadProgress")?.classList.add("hidden");panel.classList.remove("is-error");$("progressLabel").textContent=label;$("progressPct").textContent=pct+"%";$("progressBar").style.width=pct+"%";panel.classList.add("progress-active")}
function closeUploadProgress(){const modal=$("uploadProgressModal"),panel=$("progressWrap");modal?.classList.remove("is-open");modal?.setAttribute("aria-hidden","true");panel?.classList.remove("progress-active","is-error");panel?.classList.add("hidden")}
$("closeUploadProgress")?.addEventListener("click",closeUploadProgress);
async function ensureGuestSession(){
 const {data:{session}}=await supabase.auth.getSession();
 if(session?.user){guestReady=true;loadHistory();return true}
 const {data,error}=await supabase.auth.signInAnonymously();
 if(error){guestReady=false;console.error("Guest session setup:",error.message);$("historyList").innerHTML='<div class="history-empty"><p>Free guest mode is ready in the interface, but anonymous access must first be enabled in Supabase Authentication settings.</p></div>';return false}
 guestReady=!!data.user;if(guestReady)loadHistory();return guestReady;
}
async function loadHistory(){
 if(!guestReady)return;
 const [{data,error},{data:pending,error:pendingError}]=await Promise.all([
  supabase.from("analyses").select("id,overall_status,summary,created_at,media_assets(id,original_filename,sha256,mime_type,size_bytes)").order("created_at",{ascending:false}).limit(15),
  supabase.from("media_assets").select("id,original_filename,created_at,status,size_bytes").eq("status","uploaded").order("created_at",{ascending:false}).limit(20)
 ]);
 if(error){$("historyList").innerHTML='<div class="history-empty"><p>History is temporarily unavailable. You can still download each report after scanning.</p></div>';return}
 const completed=(data||[]).map(a=>{const f=a.media_assets||{};return '<div class="history-item"><div><strong>'+escapeHtml(f.original_filename||"Media file")+'</strong><small>'+new Date(a.created_at).toLocaleString()+' · '+escapeHtml((a.overall_status||"inconclusive").toUpperCase())+'</small></div><div class="history-actions"><button data-view="'+a.id+'">View report</button><button data-delete="'+f.id+'">Delete</button></div></div>'}).join("");
 const analyzedAssets=new Set((data||[]).map(a=>a.media_assets?.id).filter(Boolean));
 const recoverable=(pendingError?[]:(pending||[])).filter(f=>!analyzedAssets.has(f.id));
 const pendingHtml=recoverable.map(f=>'<div class="history-item pending-upload"><div><strong>'+escapeHtml(f.original_filename||"Uploaded media")+'</strong><small>UPLOADED · ANALYSIS NOT FINISHED · '+new Date(f.created_at).toLocaleString()+'</small></div><div class="history-actions"><button data-retry="'+f.id+'">Retry analysis</button></div></div>').join("");
 $("historyList").innerHTML=(pendingHtml?'<div class="history-empty"><p>Some files were uploaded but their reports were not completed. You can safely retry analysis.</p></div>'+pendingHtml:"")+(completed||"")||'<div class="history-empty"><span>◷</span><p>Your scans will appear here after your first upload.</p></div>';
 $("historyList").querySelectorAll("[data-view]").forEach(b=>b.addEventListener("click",()=>viewReport(b.dataset.view)));
 $("historyList").querySelectorAll("[data-delete]").forEach(b=>b.addEventListener("click",()=>deleteAsset(b.dataset.delete)));
 $("historyList").querySelectorAll("[data-retry]").forEach(b=>b.addEventListener("click",()=>retryAnalysis(b.dataset.retry,b)));
}
$("refreshHistory").addEventListener("click",loadHistory);
async function retryAnalysis(assetId,button){
 if(!assetId||!guestReady)return;
 if(button){button.disabled=true;button.textContent="Retrying…"}
 try{
  const {data:{session}}=await supabase.auth.getSession();
  if(!session?.access_token)throw new Error("Your guest session expired. Reload the page and try again.");
  const {data,error}=await supabase.functions.invoke("analyze-media",{body:{asset_id:assetId},headers:{Authorization:"Bearer "+session.access_token}});
  if(error){
   let detail=error.message||"Analysis request failed.";
   try{const body=error.context instanceof Response?await error.context.clone().json():null;if(body?.error)detail=body.error}catch{}
   throw new Error(detail);
  }
  renderResult(data);
  await loadHistory();
  toast("The pending file was analyzed successfully.");
 }catch(err){
  console.error("ORIGINVAULT retry:",err);
  toast("Retry failed: "+(err.message||"Unknown server error"));
  if(button){button.disabled=false;button.textContent="Retry analysis"}
 }
}
async function processFile(file){
 if(!file)return;
 if(file.size>MAX_FILE_BYTES){toast("Files must be 100 MB or smaller in this release.");return}
 if(!ALLOWED_MIME_TYPES.has(file.type)){toast("This format is not supported yet. Choose JPEG, PNG, WebP, HEIC, TIFF, MP4, MOV, WebM, MP3, WAV, M4A, OGG or FLAC.");return}
 if(!guestReady&&!(await ensureGuestSession())){toast("Guest mode is not enabled on the service yet. Please try again later.");return}
 const {data:{user}}=await supabase.auth.getUser();if(!user){toast("A private guest session could not be created.");return}
 const assetId=crypto.randomUUID(),safeName=file.name.replace(/[^a-zA-Z0-9._-]/g,"_").slice(0,120),path=user.id+"/"+assetId+"/"+safeName;
 $("resultPanel").classList.add("hidden");$("dropZone").classList.add("is-scanning");setProgress("Uploading securely…",12);
 try{
  const {error:uploadError}=await supabase.storage.from("originvault-private").upload(path,file,{contentType:file.type||"application/octet-stream",upsert:false});if(uploadError)throw uploadError;
  setProgress("Preparing evidence record…",46);
  const mediaType=file.type.startsWith("image/")?"image":file.type.startsWith("video/")?"video":"audio";
  const {data:asset,error:insertError}=await supabase.from("media_assets").insert({id:assetId,user_id:user.id,storage_path:path,original_filename:file.name,media_type:mediaType,mime_type:file.type,size_bytes:file.size,status:"uploaded"}).select("id").single();if(insertError)throw insertError;
  setProgress("Running free evidence engines…",68);
  const {data:{session}}=await supabase.auth.getSession();
  const {data:result,error:fnError}=await supabase.functions.invoke("analyze-media",{body:{asset_id:asset.id},headers:{Authorization:"Bearer "+session.access_token}});if(fnError)throw fnError;
  setProgress("Evidence report ready",100);$("dropZone").classList.remove("is-scanning");closeUploadProgress();renderResult({...result,filename:file.name,mime_type:file.type,size_bytes:file.size});await loadHistory();toast("Your evidence report is ready.");
 }catch(err){$("dropZone").classList.remove("is-scanning");$("progressWrap").classList.remove("progress-active");$("progressWrap").classList.add("is-error");$("progressLabel").textContent="The scan could not be completed";$("progressPct").textContent="—";$("closeUploadProgress")?.classList.remove("hidden");const detail=err?.context instanceof Response?await err.context.clone().json().catch(()=>null):null;const message=detail?.error||err.message||"Upload failed. Please try again.";toast("Scan failed: "+message);console.error("ORIGINVAULT scan:",err);await loadHistory()}
}
function aiLikelihood(detectors){
 const d=detectors.ai_deepfake||{};
 const candidates=[d.ai_generated_probability,d.ai_probability,d.probability_ai_generated];
 const raw=candidates.find(v=>typeof v==="number"&&Number.isFinite(v)&&v>=0&&v<=100);
 if(raw===undefined)return {score:null,status:d.status||"not_configured",note:d.note||""};
 return {score:Math.round(raw<=1?raw*100:raw),status:d.status||"reported",note:d.note||""};
}
function likelihoodCopy(l){
 if(l.score!==null)return l.score>=70?"The connected analysis engine estimates a high likelihood that this media is AI-generated.":l.score>=40?"The connected analysis engine estimates a moderate likelihood that this media is AI-generated.":"The connected analysis engine estimates a low likelihood that this media is AI-generated.";
 if(["detected","positive","watermark_found"].includes(l.status))return "An AI-related signal was reported, but the engine did not provide a calibrated AI-generated percentage.";
 if(["not_detected","negative","clean"].includes(l.status))return "No AI signal was reported by the connected detector. This does not prove human creation.";
 return "AI likelihood cannot currently be estimated because no AI detector is connected to this scan.";
}
function downloadFullReport(report){
 const a=report.analysis||{},l=report.aiLikelihood||{score:null,status:"not_configured"},esc=escapeHtml;
 const checks=(report.checks||[]).map(c=>"<tr><td>"+esc(c.label)+"</td><td>"+esc(c.result)+"</td><td>"+esc(c.explanation)+"</td></tr>").join("");
 const evidence=(report.evidence||[]).map(x=>"<li><b>"+esc(x.category||"Evidence")+"</b><p>"+esc(x.finding||"")+"</p><small>"+esc(x.source||"")+"</small></li>").join("");
 const score=l.score===null?"Not measured":String(l.score)+"%";
 const ring=l.score===null?"#e8edf5 0 100%":"#3b70e9 0 "+l.score+"%, #e8edf5 "+l.score+"% 100%";
 const raw=esc(JSON.stringify({analysis:a,sha256:report.sha256,checks:report.checks,evidence:report.evidence,ai_likelihood:l},null,2));
 const html='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ORIGINVAULT Evidence Report</title><style>body{font:15px Arial,sans-serif;color:#18243a;background:#f6f8fc;margin:0;padding:32px}.sheet{max-width:900px;margin:auto;background:white;padding:34px;border:1px solid #e4eaf3;border-radius:12px}h1{font-size:26px}h2{font-size:17px;margin-top:30px}.muted{color:#758198;line-height:1.6}.score{display:flex;gap:24px;align-items:center;background:#f7f9ff;padding:22px;border-radius:10px;margin:24px 0}.ring{width:132px;height:132px;border-radius:50%;background:conic-gradient("+ring+");display:grid;place-items:center;flex:none}.ring:after{content:"";width:96px;height:96px;background:white;border-radius:50%}.score strong{font-size:26px}.score p{line-height:1.6;color:#687891}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:11px;border-bottom:1px solid #e9edf4;font-size:13px;vertical-align:top}li{padding:10px 0;border-bottom:1px solid #edf1f6}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f8fc;padding:15px;border-radius:8px;font-size:11px}.notice{padding:14px;background:#fff8e9;border:1px solid #f0e2c2;border-radius:8px;color:#725d35}button{padding:10px 15px;background:#376ce8;color:white;border:0;border-radius:6px}@media print{body{background:white;padding:0}.sheet{border:0;max-width:none}}</style><div class="sheet"><div style="letter-spacing:.16em;color:#5876b3;font-size:12px">ORIGINVAULT · MEDIA INTEGRITY</div><h1>Media authenticity report</h1><p class="muted">File: "+esc(report.filename||"Media file")+"<br>Generated: "+esc(report.generatedAt||new Date().toISOString())+"<br>Analysis ID: "+esc(a.id||"Not available")+"<br>SHA-256: "+esc(report.sha256||"Not available")+"</p><section class="score"><div class="ring"></div><div><div style="font-size:12px;color:#758198">AI-GENERATED LIKELIHOOD</div><strong>"+score+"</strong><p>"+esc(likelihoodCopy(l))+"</p></div></section><p class="notice">A percentage is shown only when an enabled analysis engine explicitly returns an AI-generated probability. If no detector result is available, the report says Not measured instead of inventing a score.</p><h2>Simple results</h2><table><thead><tr><th>Check</th><th>Result</th><th>Explanation</th></tr></thead><tbody>"+checks+"</tbody></table><h2>Evidence and technical findings</h2><ul>"+(evidence||"<li>No additional evidence records were returned.</li>")+"</ul><h2>Technical details</h2><details><summary>Show complete structured analysis data</summary><pre>"+raw+"</pre></details><p class="muted">Limitations: a SHA-256 fingerprint identifies this exact file but does not establish authorship. Metadata and container markers can be edited or removed. A C2PA marker hint is not cryptographic credential validation. A negative or unavailable AI detector result is not proof of human creation, and this report cannot establish whether the media depicts true events.</p><p><button onclick="window.print()">Print / Save as PDF</button></p></div></html>'; 
 const url=URL.createObjectURL(new Blob([html],{type:"text/html;charset=utf-8"}));
 const link=document.createElement("a");link.href=url;link.download="originvault-full-report.html";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function renderResult(r){
 const a=r.analysis||r,detectors=a.detector_results||{},asset=a.media_assets||{};
 const hash=r.sha256||asset.sha256||detectors.sha256?.value||"Not available";
 const name=r.filename||asset.original_filename||a.metadata?.filename||"Media file";
 const sig=detectors.file_signature||{},meta=detectors.metadata_inspector||{};
 const hints=meta.embedded_hints||a.metadata?.embedded_metadata_hints||[];
 const inspection=r.inspection||a.metadata||{};
 const likelihood=aiLikelihood(detectors),ai=likelihood.status;
 const checks=[
  {label:"SHA-256 fingerprint",state:"yes",detail:"A unique fingerprint was calculated for this exact file."},
  {label:"File type matches",state:sig.status==="matched"?"yes":sig.status==="mismatch"?"no":"unknown",detail:sig.status==="matched"?"The actual file signature matches the uploaded type.":sig.status==="mismatch"?"The file signature does not match the declared type.":"The file type could not be confidently recognized."},
  {label:"Metadata markers found",state:hints.length?"yes":"no",detail:hints.length?hints.join(", ")+". Metadata can be edited or removed.":"No supported metadata marker was found. This does not prove that metadata is absent."},
  {label:"Possible C2PA marker",state:(inspection.c2pa_marker_candidate??detectors.c2pa?.status==="candidate_marker_found_unverified")?"yes":"no",detail:"This is only a marker check. The credential signature and signer have not been verified."},
  {label:"AI-generated / deepfake signal",state:["detected","positive","watermark_found","fake"].includes(ai)?"yes":["not_detected","negative","clean","real"].includes(ai)?"no":"unknown",detail:detectors.ai_deepfake?.note||"No compatible AI detector is running inside this scan."},
  {label:"Cryptographic C2PA verification",state:"unknown",detail:"Signature and signer trust are not validated by this release."}
 ];
 const icon={yes:"✓",no:"✕",unknown:"—"},word={yes:"YES",no:"NO",unknown:"NOT CHECKED"};
 const rows=checks.map(c=>`<div class="simple-check ${c.state}"><span class="check-icon">${icon[c.state]}</span><div class="check-copy"><strong>${escapeHtml(c.label)}</strong><p>${escapeHtml(c.detail)}</p></div><span class="check-answer">${word[c.state]}</span></div>`).join("");
 const evidence=r.evidence||a.analysis_evidence||[];
 const evidenceHtml=evidence.length?evidence.map(x=>{const severity=String(x.severity||"info").toLowerCase();const details=x.details&&typeof x.details==="object"?JSON.stringify(x.details):String(x.details||"");return `<article class="evidence-row evidence-${escapeHtml(severity)}"><div class="evidence-row-head"><strong>${escapeHtml(x.category||"Evidence")}</strong><span class="evidence-severity">${escapeHtml(severity.toUpperCase())}</span></div><p>${escapeHtml(x.finding||"")}</p><small>${escapeHtml(x.source||"ORIGINVAULT")}</small>${details?`<details><summary>Evidence details</summary><pre>${escapeHtml(details)}</pre></details>`:""}</article>`}).join(""):`<p class="evidence-empty">No additional evidence records were returned.</p>`;
 const aiEngine=detectors.ai_deepfake||{};
 const engineState=String(aiEngine.status||"not_configured").toLowerCase();
 const engineLabel=engineState==="completed"?"RESULT RECEIVED":engineState==="provider_error"?"PROVIDER ERROR":engineState==="unsupported_size"?"SIZE LIMIT":engineState==="unsupported_media"?"NOT SUPPORTED":engineState==="no_score"?"NO SCORE":"NOT CONNECTED";
 const engineTone=engineState==="completed"?"ok":engineState==="provider_error"?"warn":"idle";
 const smaugEngine=detectors.smaug||{};
 const smaugState=String(smaugEngine.status||"not_configured").toLowerCase();
 const smaugLabel=smaugState==="completed"?"RESULT RECEIVED":smaugState==="provider_error"?"PROVIDER ERROR":smaugState==="no_score"?"NO SCORE":smaugState==="unsupported_media"?"IMAGE ONLY":"NOT CONNECTED";
 const smaugTone=smaugState==="completed"?"ok":smaugState==="provider_error"?"warn":"idle";
 const smaugScore=typeof smaugEngine.ai_generated_probability==="number"?'<b class="engine-score">'+Math.round(smaugEngine.ai_generated_probability*100)+"% estimate</b>":"";
 const scanEngineResults=[aiEngine,smaugEngine].filter(engine=>engine.status==="completed").length;
 const engineDashboard=`<section class="engine-dashboard"><div class="engine-dashboard-heading"><div><span class="hash-label">MULTI-ENGINE ANALYSIS</span><h3>Detection engine status</h3></div><span class="engine-count">${scanEngineResults} / 2 RESULTS IN THIS SCAN</span></div><div class="engine-grid"><article class="engine-card engine-${engineTone}"><div class="engine-card-top"><strong>${escapeHtml(aiEngine.provider||"Sightengine · GenAI")}</strong><span>${engineLabel}</span></div><p>${escapeHtml(aiEngine.note||"Connected provider for supported image and video scans.")}</p>${typeof aiEngine.ai_generated_probability==="number"?`<b class="engine-score">${Math.round(aiEngine.ai_generated_probability*100)}% estimate</b>`:""}</article><article class="engine-card engine-${smaugTone}"><div class="engine-card-top"><strong>Smaug · Hugging Face</strong><span>${smaugLabel}</span></div><p>${escapeHtml(smaugEngine.note||"Smaug image detector status for this scan.")}</p>${smaugScore}<a href="https://huggingface.co/abacusai/Smaug-AI-Image-Detector" target="_blank" rel="noopener noreferrer">Model card & license ↗</a></article><article class="engine-card engine-ok"><div class="engine-card-top"><strong>ORIGINVAULT · File integrity</strong><span>COMPLETED</span></div><p>SHA-256 fingerprint and file-signature inspection.</p></article><article class="engine-card engine-limited"><div class="engine-card-top"><strong>ORIGINVAULT · Metadata / C2PA</strong><span>MARKER CHECK ONLY</span></div><p>Metadata hints and possible C2PA markers are inspected; cryptographic trust validation is not yet active.</p></article></div><p class="engine-footnote">Only returned provider results are counted. Engine estimates are shown separately and are not combined; unconnected engines never contribute a score. Model estimates are not proof of authenticity.</p></section>`;
 const score=likelihood.score,ringStyle=score===null?"background:conic-gradient(#e8edf5 0 100%)":"background:conic-gradient(#3b70e9 0 "+score+"%,#e8edf5 "+score+"% 100%)";
 const scoreLabel=score===null?"NOT MEASURED":score+"%";
 const scoreNote=likelihoodCopy(likelihood);
 const report={analysis:a,sha256:hash,filename:name,generatedAt:new Date().toISOString(),aiLikelihood:likelihood,checks:checks.map(c=>({label:c.label,result:word[c.state],explanation:c.detail})),evidence};
 $( "resultPanel" ).classList.remove("hidden");$("resultPanel").classList.remove("report-ready");requestAnimationFrame(()=> $("resultPanel").classList.add("report-ready"));
 $("resultPanel").innerHTML='<div class="result-top"><div><div class="eyebrow">03 / YOUR SIMPLE REPORT</div><div class="result-title">'+escapeHtml(name)+'</div><div class="result-subtitle">Created '+escapeHtml(a.created_at?new Date(a.created_at).toLocaleString():"just now")+'</div></div><span class="result-status">RESULT: INCONCLUSIVE</span></div><section class="ai-likelihood"><div class="ai-ring" style="'+ringStyle+'"><span>'+scoreLabel+'</span></div><div class="ai-summary"><div class="hash-label">AI-GENERATED LIKELIHOOD</div><h3>'+(score===null?"Not measured":score+"% estimated likelihood")+'</h3><p>'+escapeHtml(scoreNote)+'</p><small>Only an explicit AI-generated probability from an enabled detector can produce a percentage.</small></div></section><div class="simple-report-intro">In short: the percentage is an AI detector estimate, not a verdict. YES means a signal was found. NO means it was not found. NOT CHECKED means no reliable result is available.</div><div class="simple-check-list">'+rows+'</div><div class="hash-block"><div class="hash-label">YOUR FILE FINGERPRINT · SHA-256</div><div class="hash-value">'+escapeHtml(hash)+'</div></div><div class="free-tools"><div class="hash-label">FREE INDEPENDENT CHECKERS · OPTIONAL</div><p>These public tools run separately. Upload the file there yourself; ORIGINVAULT does not send it to them.</p><div class="free-tool-links"><a href="https://zinc.cse.buffalo.edu/ubmdfl/deep-o-meter" target="_blank" rel="noopener noreferrer">DeepFake-o-meter ↗</a><a href="https://scanner.deepware.ai/" target="_blank" rel="noopener noreferrer">Deepware Scanner ↗</a><a href="https://contentcredentials.org/verify" target="_blank" rel="noopener noreferrer">Content Credentials Verify ↗</a></div></div>'+engineDashboard+'<section class="professional-evidence"><div class="hash-label">EVIDENCE REGISTER</div><h3>Findings and supporting details</h3><div class="professional-evidence-list">'+evidenceHtml+'</div></section><details class="technical-details"><summary>More explanation · technical details</summary><div class="technical-inner"><p>'+escapeHtml(scoreNote)+'</p><div class="evidence-list">'+evidenceHtml+'</div><pre class="raw-report">'+escapeHtml(JSON.stringify(report,null,2))+'</pre></div></details><p class="result-disclaimer">A fingerprint and technical markers cannot prove who created media or whether its contents are true. A negative detector result is not proof that a file is authentic. C2PA signature validation and specialist AI/deepfake detection are not connected unless a detector result is explicitly returned.</p><div class="result-actions"><button class="primary-mini" id="downloadReport">Download complete report ↓</button><button id="downloadData">Download JSON data</button><button id="copyHash">Copy fingerprint</button></div>';
 $("downloadReport").addEventListener("click",()=>downloadFullReport(report));
 $("downloadData").addEventListener("click",()=>downloadJson(report));
 $("copyHash").addEventListener("click",async()=>{try{await navigator.clipboard.writeText(hash);toast("Fingerprint copied.")}catch{toast("Copy is not available in this browser.")}});
 openReportModal();
}
async function viewReport(id){
 const {data,error}=await supabase.from("analyses").select("*,media_assets(original_filename,mime_type,size_bytes,sha256),analysis_evidence(category,finding,severity,source,details)").eq("id",id).single();
 if(error){toast("Could not open this report.");return}
 renderResult({analysis:data,sha256:data.media_assets?.sha256,filename:data.media_assets?.original_filename,message:data.summary,evidence:data.analysis_evidence});
}
async function deleteAsset(id){
 if(!id||!confirm("Delete this file and its evidence history? This cannot be undone."))return;
 const {data:asset,error:readError}=await supabase.from("media_assets").select("id,storage_path").eq("id",id).single();if(readError){toast("Could not find this file.");return}
 const {error:storageError}=await supabase.storage.from("originvault-private").remove([asset.storage_path]);if(storageError){toast("Could not delete the private file.");return}
 const {error:deleteError}=await supabase.from("media_assets").delete().eq("id",id);if(deleteError){toast("File removed from storage, but its record could not be deleted.");return}
 $("resultPanel").classList.add("hidden");await loadHistory();toast("File and evidence history deleted.");
}
function downloadJson(report){
 const payload={product:"ORIGINVAULT",generated_at:new Date().toISOString(),disclaimer:"This report includes SHA-256, file-signature/MIME inspection, lightweight metadata/container marker checks, and a non-validating C2PA marker hint. It does not establish creator identity, provenance or truth. A specialist AI/deepfake detector is not connected unless an explicit detector probability appears below.",...report};
 const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
 const url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download="originvault-evidence-report.json";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
const zone=$("dropZone");
zone.addEventListener("dragover",e=>{e.preventDefault();zone.classList.add("drag")});
zone.addEventListener("dragleave",()=>zone.classList.remove("drag"));
let selectedUploadFile=null;
function selectUploadFile(file){selectedUploadFile=file||null;const name=$("selectedFileName"),button=$("uploadNow");if(name){name.textContent=file?("Selected: "+file.name):"No file selected";name.classList.toggle("hidden",!file)}if(button){button.disabled=!file;button.classList.toggle("hidden",!file)}}
zone.addEventListener("drop",e=>{e.preventDefault();zone.classList.remove("drag");selectUploadFile(e.dataTransfer.files[0])});
$("fileInput").addEventListener("change",e=>selectUploadFile(e.target.files[0]));


supabase.auth.onAuthStateChange((_event,session)=>{if(session?.user){guestReady=true;loadHistory()}else guestReady=false});
window.ORIGINVAULT_UPLOAD = processFile;
ensureGuestSession().catch(err=>{guestReady=false;toast(String(err&&err.message||'Guest session failed'))});

const contractCopyButton=$("copyContractAddress");
contractCopyButton?.addEventListener("click",async()=>{
 const address=contractCopyButton.dataset.contractAddress?.trim();
 if(!address){toast("The token contract address will be added after launch.");return}
 try{await navigator.clipboard.writeText(address);toast("Token contract address copied.")}
 catch{toast("Could not copy the contract address in this browser.")}
});

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.105.0";
const SUPABASE_URL="https://riydudeuprhygldpqsiw.supabase.co";
const SUPABASE_PUBLISHABLE_KEY="sb_publishable_P1DfLEvSt-jo-vFx16qLoQ_-g7-JfRK";
const supabase=createClient(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
const $=id=>document.getElementById(id);
const MAX_FILE_BYTES=100*1024*1024;
const ALLOWED_MIME_TYPES=new Set(["image/jpeg","image/png","image/webp","image/heic","image/tiff","video/mp4","video/quicktime","video/webm","audio/mpeg","audio/wav","audio/mp4","audio/ogg","audio/flac"]);
let guestReady=false;
function toast(message){$("toast").textContent=message;$("toast").classList.add("show");setTimeout(()=>$("toast").classList.remove("show"),3300)}
function escapeHtml(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function setProgress(label,pct){const modal=$("uploadProgressModal"),panel=$("progressWrap");modal?.classList.add("is-open");modal?.setAttribute("aria-hidden","false");panel.classList.remove("hidden");$("closeUploadProgress")?.classList.add("hidden");panel.classList.remove("is-error");$("progressLabel").textContent=label;$("progressPct").textContent=pct+"%";$("progressBar").style.width=pct+"%";panel.classList.add("progress-active")}
function closeUploadProgress(){const modal=$("uploadProgressModal"),panel=$("progressWrap");modal?.classList.remove("is-open");modal?.setAttribute("aria-hidden","true");panel?.classList.remove("progress-active","is-error");panel?.classList.add("hidden")}
$("closeUploadProgress")?.addEventListener("click",closeUploadProgress);
async function ensureGuestSession(){
 const {data:{session}}=await supabase.auth.getSession();
 if(session?.user){guestReady=true;loadHistory();return true}
 const {data,error}=await supabase.auth.signInAnonymously();
 if(error){guestReady=false;console.error("Guest session setup:",error.message);$("historyList").innerHTML='<div class="history-empty"><p>Free guest mode is ready in the interface, but anonymous access must first be enabled in Supabase Authentication settings.</p></div>';return false}
 guestReady=!!data.user;if(guestReady)loadHistory();return guestReady;
}
async function loadHistory(){
 if(!guestReady)return;
 const [{data,error},{data:pending,error:pendingError}]=await Promise.all([
  supabase.from("analyses").select("id,overall_status,summary,created_at,media_assets(id,original_filename,sha256,mime_type,size_bytes)").order("created_at",{ascending:false}).limit(15),
  supabase.from("media_assets").select("id,original_filename,created_at,status,size_bytes").eq("status","uploaded").order("created_at",{ascending:false}).limit(20)
 ]);
 if(error){$("historyList").innerHTML='<div class="history-empty"><p>History is temporarily unavailable. You can still download each report after scanning.</p></div>';return}
 const completed=(data||[]).map(a=>{const f=a.media_assets||{};return '<div class="history-item"><div><strong>'+escapeHtml(f.original_filename||"Media file")+'</strong><small>'+new Date(a.created_at).toLocaleString()+' · '+escapeHtml((a.overall_status||"inconclusive").toUpperCase())+'</small></div><div class="history-actions"><button data-view="'+a.id+'">View report</button><button data-delete="'+f.id+'">Delete</button></div></div>'}).join("");
 const analyzedAssets=new Set((data||[]).map(a=>a.media_assets?.id).filter(Boolean));
 const recoverable=(pendingError?[]:(pending||[])).filter(f=>!analyzedAssets.has(f.id));
 const pendingHtml=recoverable.map(f=>'<div class="history-item pending-upload"><div><strong>'+escapeHtml(f.original_filename||"Uploaded media")+'</strong><small>UPLOADED · ANALYSIS NOT FINISHED · '+new Date(f.created_at).toLocaleString()+'</small></div><div class="history-actions"><button data-retry="'+f.id+'">Retry analysis</button></div></div>').join("");
 $("historyList").innerHTML=(pendingHtml?'<div class="history-empty"><p>Some files were uploaded but their reports were not completed. You can safely retry analysis.</p></div>'+pendingHtml:"")+(completed||"")||'<div class="history-empty"><span>◷</span><p>Your scans will appear here after your first upload.</p></div>';
 $("historyList").querySelectorAll("[data-view]").forEach(b=>b.addEventListener("click",()=>viewReport(b.dataset.view)));
 $("historyList").querySelectorAll("[data-delete]").forEach(b=>b.addEventListener("click",()=>deleteAsset(b.dataset.delete)));
 $("historyList").querySelectorAll("[data-retry]").forEach(b=>b.addEventListener("click",()=>retryAnalysis(b.dataset.retry,b)));
}
$("refreshHistory").addEventListener("click",loadHistory);
async function retryAnalysis(assetId,button){
 if(!assetId||!guestReady)return;
 if(button){button.disabled=true;button.textContent="Retrying…"}
 try{
  const {data:{session}}=await supabase.auth.getSession();
  if(!session?.access_token)throw new Error("Your guest session expired. Reload the page and try again.");
  const {data,error}=await supabase.functions.invoke("analyze-media",{body:{asset_id:assetId},headers:{Authorization:"Bearer "+session.access_token}});
  if(error){
   let detail=error.message||"Analysis request failed.";
   try{const body=error.context instanceof Response?await error.context.clone().json():null;if(body?.error)detail=body.error}catch{}
   throw new Error(detail);
  }
  renderResult(data);
  await loadHistory();
  toast("The pending file was analyzed successfully.");
 }catch(err){
  console.error("ORIGINVAULT retry:",err);
  toast("Retry failed: "+(err.message||"Unknown server error"));
  if(button){button.disabled=false;button.textContent="Retry analysis"}
 }
}
async function processFile(file){
 if(!file)return;
 if(file.size>MAX_FILE_BYTES){toast("Files must be 100 MB or smaller in this release.");return}
 if(!ALLOWED_MIME_TYPES.has(file.type)){toast("This format is not supported yet. Choose JPEG, PNG, WebP, HEIC, TIFF, MP4, MOV, WebM, MP3, WAV, M4A, OGG or FLAC.");return}
 if(!guestReady&&!(await ensureGuestSession())){toast("Guest mode is not enabled on the service yet. Please try again later.");return}
 const {data:{user}}=await supabase.auth.getUser();if(!user){toast("A private guest session could not be created.");return}
 const assetId=crypto.randomUUID(),safeName=file.name.replace(/[^a-zA-Z0-9._-]/g,"_").slice(0,120),path=user.id+"/"+assetId+"/"+safeName;
 $("resultPanel").classList.add("hidden");$("dropZone").classList.add("is-scanning");setProgress("Uploading securely…",12);
 try{
  const {error:uploadError}=await supabase.storage.from("originvault-private").upload(path,file,{contentType:file.type||"application/octet-stream",upsert:false});if(uploadError)throw uploadError;
  setProgress("Preparing evidence record…",46);
  const mediaType=file.type.startsWith("image/")?"image":file.type.startsWith("video/")?"video":"audio";
  const {data:asset,error:insertError}=await supabase.from("media_assets").insert({id:assetId,user_id:user.id,storage_path:path,original_filename:file.name,media_type:mediaType,mime_type:file.type,size_bytes:file.size,status:"uploaded"}).select("id").single();if(insertError)throw insertError;
  setProgress("Running free evidence engines…",68);
  const {data:{session}}=await supabase.auth.getSession();
  const {data:result,error:fnError}=await supabase.functions.invoke("analyze-media",{body:{asset_id:asset.id},headers:{Authorization:"Bearer "+session.access_token}});if(fnError)throw fnError;
  setProgress("Evidence report ready",100);$("dropZone").classList.remove("is-scanning");closeUploadProgress();renderResult({...result,filename:file.name,mime_type:file.type,size_bytes:file.size});await loadHistory();toast("Your evidence report is ready.");
 }catch(err){$("dropZone").classList.remove("is-scanning");$("progressWrap").classList.remove("progress-active");$("progressWrap").classList.add("is-error");$("progressLabel").textContent="The scan could not be completed";$("progressPct").textContent="—";$("closeUploadProgress")?.classList.remove("hidden");const detail=err?.context instanceof Response?await err.context.clone().json().catch(()=>null):null;const message=detail?.error||err.message||"Upload failed. Please try again.";toast("Scan failed: "+message);console.error("ORIGINVAULT scan:",err);await loadHistory()}
}
function aiLikelihood(detectors){
 const d=detectors.ai_deepfake||{};
 const candidates=[d.ai_generated_probability,d.ai_probability,d.probability_ai_generated];
 const raw=candidates.find(v=>typeof v==="number"&&Number.isFinite(v)&&v>=0&&v<=100);
 if(raw===undefined)return {score:null,status:d.status||"not_configured",note:d.note||""};
 return {score:Math.round(raw<=1?raw*100:raw),status:d.status||"reported",note:d.note||""};
}
function likelihoodCopy(l){
 if(l.score!==null)return l.score>=70?"The connected analysis engine estimates a high likelihood that this media is AI-generated.":l.score>=40?"The connected analysis engine estimates a moderate likelihood that this media is AI-generated.":"The connected analysis engine estimates a low likelihood that this media is AI-generated.";
 if(["detected","positive","watermark_found"].includes(l.status))return "An AI-related signal was reported, but the engine did not provide a calibrated AI-generated percentage.";
 if(["not_detected","negative","clean"].includes(l.status))return "No AI signal was reported by the connected detector. This does not prove human creation.";
 return "AI likelihood cannot currently be estimated because no AI detector is connected to this scan.";
}
function downloadFullReport(report){
 const a=report.analysis||{},l=report.aiLikelihood||{score:null,status:"not_configured"},esc=escapeHtml;
 const checks=(report.checks||[]).map(c=>"<tr><td>"+esc(c.label)+"</td><td>"+esc(c.result)+"</td><td>"+esc(c.explanation)+"</td></tr>").join("");
 const evidence=(report.evidence||[]).map(x=>"<li><b>"+esc(x.category||"Evidence")+"</b><p>"+esc(x.finding||"")+"</p><small>"+esc(x.source||"")+"</small></li>").join("");
 const score=l.score===null?"Not measured":String(l.score)+"%";
 const ring=l.score===null?"#e8edf5 0 100%":"#3b70e9 0 "+l.score+"%, #e8edf5 "+l.score+"% 100%";
 const raw=esc(JSON.stringify({analysis:a,sha256:report.sha256,checks:report.checks,evidence:report.evidence,ai_likelihood:l},null,2));
 const html='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ORIGINVAULT Evidence Report</title><style>body{font:15px Arial,sans-serif;color:#18243a;background:#f6f8fc;margin:0;padding:32px}.sheet{max-width:900px;margin:auto;background:white;padding:34px;border:1px solid #e4eaf3;border-radius:12px}h1{font-size:26px}h2{font-size:17px;margin-top:30px}.muted{color:#758198;line-height:1.6}.score{display:flex;gap:24px;align-items:center;background:#f7f9ff;padding:22px;border-radius:10px;margin:24px 0}.ring{width:132px;height:132px;border-radius:50%;background:conic-gradient("+ring+");display:grid;place-items:center;flex:none}.ring:after{content:"";width:96px;height:96px;background:white;border-radius:50%}.score strong{font-size:26px}.score p{line-height:1.6;color:#687891}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:11px;border-bottom:1px solid #e9edf4;font-size:13px;vertical-align:top}li{padding:10px 0;border-bottom:1px solid #edf1f6}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f8fc;padding:15px;border-radius:8px;font-size:11px}.notice{padding:14px;background:#fff8e9;border:1px solid #f0e2c2;border-radius:8px;color:#725d35}button{padding:10px 15px;background:#376ce8;color:white;border:0;border-radius:6px}@media print{body{background:white;padding:0}.sheet{border:0;max-width:none}}</style><div class="sheet"><div style="letter-spacing:.16em;color:#5876b3;font-size:12px">ORIGINVAULT · MEDIA INTEGRITY</div><h1>Media authenticity report</h1><p class="muted">File: "+esc(report.filename||"Media file")+"<br>Generated: "+esc(report.generatedAt||new Date().toISOString())+"<br>Analysis ID: "+esc(a.id||"Not available")+"<br>SHA-256: "+esc(report.sha256||"Not available")+"</p><section class="score"><div class="ring"></div><div><div style="font-size:12px;color:#758198">AI-GENERATED LIKELIHOOD</div><strong>"+score+"</strong><p>"+esc(likelihoodCopy(l))+"</p></div></section><p class="notice">A percentage is shown only when an enabled analysis engine explicitly returns an AI-generated probability. If no detector result is available, the report says Not measured instead of inventing a score.</p><h2>Simple results</h2><table><thead><tr><th>Check</th><th>Result</th><th>Explanation</th></tr></thead><tbody>"+checks+"</tbody></table><h2>Evidence and technical findings</h2><ul>"+(evidence||"<li>No additional evidence records were returned.</li>")+"</ul><h2>Technical details</h2><details><summary>Show complete structured analysis data</summary><pre>"+raw+"</pre></details><p class="muted">Limitations: a SHA-256 fingerprint identifies this exact file but does not establish authorship. Metadata and container markers can be edited or removed. A C2PA marker hint is not cryptographic credential validation. A negative or unavailable AI detector result is not proof of human creation, and this report cannot establish whether the media depicts true events.</p><p><button onclick="window.print()">Print / Save as PDF</button></p></div></html>'; 
 const url=URL.createObjectURL(new Blob([html],{type:"text/html;charset=utf-8"}));
 const link=document.createElement("a");link.href=url;link.download="originvault-full-report.html";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function renderResult(r){
 const a=r.analysis||r,detectors=a.detector_results||{},asset=a.media_assets||{};
 const hash=r.sha256||asset.sha256||detectors.sha256?.value||"Not available";
 const name=r.filename||asset.original_filename||a.metadata?.filename||"Media file";
 const sig=detectors.file_signature||{},meta=detectors.metadata_inspector||{};
 const hints=meta.embedded_hints||a.metadata?.embedded_metadata_hints||[];
 const inspection=r.inspection||a.metadata||{};
 const likelihood=aiLikelihood(detectors),ai=likelihood.status;
 const checks=[
  {label:"SHA-256 fingerprint",state:"yes",detail:"A unique fingerprint was calculated for this exact file."},
  {label:"File type matches",state:sig.status==="matched"?"yes":sig.status==="mismatch"?"no":"unknown",detail:sig.status==="matched"?"The actual file signature matches the uploaded type.":sig.status==="mismatch"?"The file signature does not match the declared type.":"The file type could not be confidently recognized."},
  {label:"Metadata markers found",state:hints.length?"yes":"no",detail:hints.length?hints.join(", ")+". Metadata can be edited or removed.":"No supported metadata marker was found. This does not prove that metadata is absent."},
  {label:"Possible C2PA marker",state:(inspection.c2pa_marker_candidate??detectors.c2pa?.status==="candidate_marker_found_unverified")?"yes":"no",detail:"This is only a marker check. The credential signature and signer have not been verified."},
  {label:"AI-generated / deepfake signal",state:["detected","positive","watermark_found","fake"].includes(ai)?"yes":["not_detected","negative","clean","real"].includes(ai)?"no":"unknown",detail:detectors.ai_deepfake?.note||"No compatible AI detector is running inside this scan."},
  {label:"Cryptographic C2PA verification",state:"unknown",detail:"Signature and signer trust are not validated by this release."}
 ];
 const icon={yes:"✓",no:"✕",unknown:"—"},word={yes:"YES",no:"NO",unknown:"NOT CHECKED"};
 const rows=checks.map(c=>`<div class="simple-check ${c.state}"><span class="check-icon">${icon[c.state]}</span><div class="check-copy"><strong>${escapeHtml(c.label)}</strong><p>${escapeHtml(c.detail)}</p></div><span class="check-answer">${word[c.state]}</span></div>`).join("");
 const evidence=r.evidence||a.analysis_evidence||[];
 const evidenceHtml=evidence.length?evidence.map(x=>{const severity=String(x.severity||"info").toLowerCase();const details=x.details&&typeof x.details==="object"?JSON.stringify(x.details):String(x.details||"");return `<article class="evidence-row evidence-${escapeHtml(severity)}"><div class="evidence-row-head"><strong>${escapeHtml(x.category||"Evidence")}</strong><span class="evidence-severity">${escapeHtml(severity.toUpperCase())}</span></div><p>${escapeHtml(x.finding||"")}</p><small>${escapeHtml(x.source||"ORIGINVAULT")}</small>${details?`<details><summary>Evidence details</summary><pre>${escapeHtml(details)}</pre></details>`:""}</article>`}).join(""):`<p class="evidence-empty">No additional evidence records were returned.</p>`;
 const aiEngine=detectors.ai_deepfake||{};
 const engineState=String(aiEngine.status||"not_configured").toLowerCase();
 const engineLabel=engineState==="completed"?"RESULT RECEIVED":engineState==="provider_error"?"PROVIDER ERROR":engineState==="unsupported_size"?"SIZE LIMIT":engineState==="unsupported_media"?"NOT SUPPORTED":engineState==="no_score"?"NO SCORE":"NOT CONNECTED";
 const engineTone=engineState==="completed"?"ok":engineState==="provider_error"?"warn":"idle";
 const smaugEngine=detectors.smaug||{};
 const smaugState=String(smaugEngine.status||"not_configured").toLowerCase();
 const smaugLabel=smaugState==="completed"?"RESULT RECEIVED":smaugState==="provider_error"?"PROVIDER ERROR":smaugState==="no_score"?"NO SCORE":smaugState==="unsupported_media"?"IMAGE ONLY":"NOT CONNECTED";
 const smaugTone=smaugState==="completed"?"ok":smaugState==="provider_error"?"warn":"idle";
 const smaugScore=typeof smaugEngine.ai_generated_probability==="number"?'<b class="engine-score">'+Math.round(smaugEngine.ai_generated_probability*100)+"% estimate</b>":"";
 const scanEngineResults=[aiEngine,smaugEngine].filter(engine=>engine.status==="completed").length;
 const engineDashboard=`<section class="engine-dashboard"><div class="engine-dashboard-heading"><div><span class="hash-label">MULTI-ENGINE ANALYSIS</span><h3>Detection engine status</h3></div><span class="engine-count">${scanEngineResults} / 2 RESULTS IN THIS SCAN</span></div><div class="engine-grid"><article class="engine-card engine-${engineTone}"><div class="engine-card-top"><strong>${escapeHtml(aiEngine.provider||"Sightengine · GenAI")}</strong><span>${engineLabel}</span></div><p>${escapeHtml(aiEngine.note||"Connected provider for supported image and video scans.")}</p>${typeof aiEngine.ai_generated_probability==="number"?`<b class="engine-score">${Math.round(aiEngine.ai_generated_probability*100)}% estimate</b>`:""}</article><article class="engine-card engine-${smaugTone}"><div class="engine-card-top"><strong>Smaug · Hugging Face</strong><span>${smaugLabel}</span></div><p>${escapeHtml(smaugEngine.note||"Smaug image detector status for this scan.")}</p>${smaugScore}<a href="https://huggingface.co/abacusai/Smaug-AI-Image-Detector" target="_blank" rel="noopener noreferrer">Model card & license ↗</a></article><article class="engine-card engine-ok"><div class="engine-card-top"><strong>ORIGINVAULT · File integrity</strong><span>COMPLETED</span></div><p>SHA-256 fingerprint and file-signature inspection.</p></article><article class="engine-card engine-limited"><div class="engine-card-top"><strong>ORIGINVAULT · Metadata / C2PA</strong><span>MARKER CHECK ONLY</span></div><p>Metadata hints and possible C2PA markers are inspected; cryptographic trust validation is not yet active.</p></article></div><p class="engine-footnote">Only returned provider results are counted. Engine estimates are shown separately and are not combined; unconnected engines never contribute a score. Model estimates are not proof of authenticity.</p></section>`;
 const score=likelihood.score,ringStyle=score===null?"background:conic-gradient(#e8edf5 0 100%)":"background:conic-gradient(#3b70e9 0 "+score+"%,#e8edf5 "+score+"% 100%)";
 const scoreLabel=score===null?"NOT MEASURED":score+"%";
 const scoreNote=likelihoodCopy(likelihood);
 const report={analysis:a,sha256:hash,filename:name,generatedAt:new Date().toISOString(),aiLikelihood:likelihood,checks:checks.map(c=>({label:c.label,result:word[c.state],explanation:c.detail})),evidence};
 $( "resultPanel" ).classList.remove("hidden");$("resultPanel").classList.remove("report-ready");requestAnimationFrame(()=> $("resultPanel").classList.add("report-ready"));
 $("resultPanel").innerHTML='<div class="result-top"><div><div class="eyebrow">03 / YOUR SIMPLE REPORT</div><div class="result-title">'+escapeHtml(name)+'</div><div class="result-subtitle">Created '+escapeHtml(a.created_at?new Date(a.created_at).toLocaleString():"just now")+'</div></div><span class="result-status">RESULT: INCONCLUSIVE</span></div><section class="ai-likelihood"><div class="ai-ring" style="'+ringStyle+'"><span>'+scoreLabel+'</span></div><div class="ai-summary"><div class="hash-label">AI-GENERATED LIKELIHOOD</div><h3>'+(score===null?"Not measured":score+"% estimated likelihood")+'</h3><p>'+escapeHtml(scoreNote)+'</p><small>Only an explicit AI-generated probability from an enabled detector can produce a percentage.</small></div></section><div class="simple-report-intro">In short: the percentage is an AI detector estimate, not a verdict. YES means a signal was found. NO means it was not found. NOT CHECKED means no reliable result is available.</div><div class="simple-check-list">'+rows+'</div><div class="hash-block"><div class="hash-label">YOUR FILE FINGERPRINT · SHA-256</div><div class="hash-value">'+escapeHtml(hash)+'</div></div><div class="free-tools"><div class="hash-label">FREE INDEPENDENT CHECKERS · OPTIONAL</div><p>These public tools run separately. Upload the file there yourself; ORIGINVAULT does not send it to them.</p><div class="free-tool-links"><a href="https://zinc.cse.buffalo.edu/ubmdfl/deep-o-meter" target="_blank" rel="noopener noreferrer">DeepFake-o-meter ↗</a><a href="https://scanner.deepware.ai/" target="_blank" rel="noopener noreferrer">Deepware Scanner ↗</a><a href="https://contentcredentials.org/verify" target="_blank" rel="noopener noreferrer">Content Credentials Verify ↗</a></div></div>'+engineDashboard+'<section class="professional-evidence"><div class="hash-label">EVIDENCE REGISTER</div><h3>Findings and supporting details</h3><div class="professional-evidence-list">'+evidenceHtml+'</div></section><details class="technical-details"><summary>More explanation · technical details</summary><div class="technical-inner"><p>'+escapeHtml(scoreNote)+'</p><div class="evidence-list">'+evidenceHtml+'</div><pre class="raw-report">'+escapeHtml(JSON.stringify(report,null,2))+'</pre></div></details><p class="result-disclaimer">A fingerprint and technical markers cannot prove who created media or whether its contents are true. A negative detector result is not proof that a file is authentic. C2PA signature validation and specialist AI/deepfake detection are not connected unless a detector result is explicitly returned.</p><div class="result-actions"><button class="primary-mini" id="downloadReport">Download complete report ↓</button><button id="downloadData">Download JSON data</button><button id="copyHash">Copy fingerprint</button></div>';
 $("downloadReport").addEventListener("click",()=>downloadFullReport(report));
 $("downloadData").addEventListener("click",()=>downloadJson(report));
 $("copyHash").addEventListener("click",async()=>{try{await navigator.clipboard.writeText(hash);toast("Fingerprint copied.")}catch{toast("Copy is not available in this browser.")}});
 openReportModal();
}
async function viewReport(id){
 const {data,error}=await supabase.from("analyses").select("*,media_assets(original_filename,mime_type,size_bytes,sha256),analysis_evidence(category,finding,severity,source,details)").eq("id",id).single();
 if(error){toast("Could not open this report.");return}
 renderResult({analysis:data,sha256:data.media_assets?.sha256,filename:data.media_assets?.original_filename,message:data.summary,evidence:data.analysis_evidence});
}
async function deleteAsset(id){
 if(!id||!confirm("Delete this file and its evidence history? This cannot be undone."))return;
 const {data:asset,error:readError}=await supabase.from("media_assets").select("id,storage_path").eq("id",id).single();if(readError){toast("Could not find this file.");return}
 const {error:storageError}=await supabase.storage.from("originvault-private").remove([asset.storage_path]);if(storageError){toast("Could not delete the private file.");return}
 const {error:deleteError}=await supabase.from("media_assets").delete().eq("id",id);if(deleteError){toast("File removed from storage, but its record could not be deleted.");return}
 $("resultPanel").classList.add("hidden");await loadHistory();toast("File and evidence history deleted.");
}
function downloadJson(report){
 const payload={product:"ORIGINVAULT",generated_at:new Date().toISOString(),disclaimer:"This report includes SHA-256, file-signature/MIME inspection, lightweight metadata/container marker checks, and a non-validating C2PA marker hint. It does not establish creator identity, provenance or truth. A specialist AI/deepfake detector is not connected unless an explicit detector probability appears below.",...report};
 const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
 const url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download="originvault-evidence-report.json";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
const zone=$("dropZone");
zone.addEventListener("dragover",e=>{e.preventDefault();zone.classList.add("drag")});
zone.addEventListener("dragleave",()=>zone.classList.remove("drag"));
let selectedUploadFile=null;
function selectUploadFile(file){selectedUploadFile=file||null;const name=$("selectedFileName"),button=$("uploadNow");if(name){name.textContent=file?("Selected: "+file.name):"No file selected";name.classList.toggle("hidden",!file)}if(button){button.disabled=!file;button.classList.toggle("hidden",!file)}}
zone.addEventListener("drop",e=>{e.preventDefault();zone.classList.remove("drag");selectUploadFile(e.dataTransfer.files[0])});
$("fileInput").addEventListener("change",e=>selectUploadFile(e.target.files[0]));


supabase.auth.onAuthStateChange((_event,session)=>{if(session?.user){guestReady=true;loadHistory()}else guestReady=false});
window.ORIGINVAULT_UPLOAD = processFile;
ensureGuestSession().catch(err=>{guestReady=false;toast(String(err&&err.message||'Guest session failed'))});

function openReportModal(){
 closeUploadProgress();
 const panel=$("resultPanel"),modal=$("reportModal"),body=$("reportModalBody");
 if(!panel||!modal||!body)return;
 body.replaceChildren();
 while(panel.firstChild)body.appendChild(panel.firstChild);
 modal.classList.add("is-open");
 modal.setAttribute("aria-hidden","false");
 document.body.classList.add("report-modal-open");
 $("closeReportModal")?.focus();
}
function closeReportModal(){
 const modal=$("reportModal");
 if(!modal)return;
 modal.classList.remove("is-open");
 modal.setAttribute("aria-hidden","true");
 document.body.classList.remove("report-modal-open");
 $("scanner")?.scrollIntoView({behavior:"smooth",block:"nearest"});
}
$("closeReportModal")?.addEventListener("click",closeReportModal);
$("reportModal")?.querySelectorAll("[data-report-close]").forEach(el=>el.addEventListener("click",closeReportModal));
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&$("reportModal")?.classList.contains("is-open"))closeReportModal()});

 closeUploadProgress();
 const panel=$("resultPanel"),modal=$("reportModal"),body=$("reportModalBody");
 if(!panel||!modal||!body)return;
 body.replaceChildren();
 while(panel.firstChild)body.appendChild(panel.firstChild);
 modal.classList.add("is-open");
 modal.setAttribute("aria-hidden","false");
 document.body.classList.add("report-modal-open");
 $("closeReportModal")?.focus();
}
function closeReportModal(){
 const modal=$("reportModal");
 if(!modal)return;
 modal.classList.remove("is-open");
 modal.setAttribute("aria-hidden","true");
 document.body.classList.remove("report-modal-open");
 $("scanner")?.scrollIntoView({behavior:"smooth",block:"nearest"});
}
$("closeReportModal")?.addEventListener("click",closeReportModal);
$("reportModal")?.querySelectorAll("[data-report-close]").forEach(el=>el.addEventListener("click",closeReportModal));
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&$("reportModal")?.classList.contains("is-open"))closeReportModal()});
