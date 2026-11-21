/* Cloud storage for the trip planner. No admin credentials or travel plans in this file. */
(() => {
"use strict";
const url="https://behmlnidshowsmufuvyq.supabase.co";
const key="sb_publishable_ra-jdoS-RHdmtrnee8Uz3Q_t70wcDMC";
const redirect="https://frodekristiansen88-cpu.github.io/familiens-feriedrommer/";
const clone=x=>JSON.parse(JSON.stringify(x));
const canonical=t=>JSON.stringify([t.id,t.name,t.lat,t.lng,t.radiusKm,t.placeIds]);
let api,client,user=null,busy=false,ready=false,dirty=false,baseline=new Map(),status="",generation=0,recovery=false;
let root,ui={};
const byId=id=>root.querySelector("#"+id);
const draftKey=()=> "feriekart-usynkronisert-v1-"+user.id;
function show(msg){status=msg;render();}
function draft(trips){if(!user)return;try{localStorage.setItem(draftKey(),JSON.stringify({format:"familiens-feriedrommer-turer",version:1,trips}));}catch(e){show("Kunne ikke lagre lokal reservekopi. Bruk Eksporter før du lukker siden.");}}
function clearDraft(){try{localStorage.removeItem(draftKey());}catch(e){}}
function getDraft(){try{return user?localStorage.getItem(draftKey()):null;}catch(e){return null;}}
function render(){
 if(!root)return;
 ui.account.textContent=user?"Innlogget: "+(user.email||""):"Ikke innlogget – lokale turmapper";
 ui.status.textContent=status;
 ui.form.hidden=!!user&&!recovery;
 ui.login.hidden=recovery;ui.signup.hidden=recovery;ui.reset.hidden=recovery;
 ui.email.hidden=recovery;ui.password.placeholder=recovery?"Nytt passord":"Passord (minst 8 tegn)";
 ui.recovery.hidden=!recovery;
 ui.signout.hidden=!user;ui.refresh.hidden=!user;ui.transfer.hidden=!user;
 ui.share.hidden=!user;ui.retry.hidden=!user||!dirty;ui.backup.hidden=!user||!getDraft();ui.discard.hidden=!user||!dirty;
 for(const b of [ui.login,ui.signup,ui.reset,ui.recovery,ui.signout,ui.refresh,ui.transfer,ui.share,ui.retry,ui.discard])b.disabled=busy;
 ui.transfer.disabled=busy||!ready||dirty;ui.share.disabled=busy||!ready||dirty||!isOwner(api?.selectedId());
 ui.refresh.disabled=busy||dirty;
 api?.refreshControls();
}
function isOwner(id){return !!user&&baseline.get(id)?.owner_id===user.id;}
function active(){return !!user;}
function writable(){return !user||(!busy&&ready&&!dirty&&!recovery);}
function validRows(rows){
 const normalized=[];
 for(const row of rows){
  const trip=api.sanitize({...row.data,id:row.id});
  if(!trip)throw Error("En turmappe har ugyldige data. Ingen data er endret.");
  normalized.push({...row,trip});
 }
 return normalized;
}
async function fetchRows(){
 const {data,error}=await client.from("trip_plans").select("id,owner_id,data,shared_with,updated_at").order("updated_at",{ascending:false});
 if(error)throw error;
 return validRows(data||[]);
}
function sameRows(rows){return rows.length===baseline.size&&rows.every(r=>baseline.get(r.id)?.updated_at===r.updated_at);}
function applyRows(rows){
 baseline=new Map(rows.map(r=>[r.id,r]));
 api.replace(rows.map(r=>r.trip));
}
async function load(force=false){
 if(!user||busy||dirty||recovery)return;
 const epoch=generation;
 busy=true;render();
 try{
  const rows=await fetchRows();
  if(epoch!==generation)return;
  if(force||!ready||!sameRows(rows))applyRows(rows);
  ready=true;status="Synkronisert med skyen · "+rows.length+" turmapper";
 }catch(e){if(epoch===generation){status="Kunne ikke hente turmapper: "+(e.message||"nettverksfeil");}}
 finally{if(epoch===generation){busy=false;render();}}
}
async function save(trips){
 if(!user||!ready||busy||recovery)return false;
 const epoch=generation,target=clone(trips);
 dirty=true;busy=true;draft(target);status="Lagrer i skyen …";render();
 try{
  // Update only modified rows. The server timestamp rejects concurrent edits.
  for(const t of target){
   const old=baseline.get(t.id);
   if(old&&canonical(t)===canonical(old.trip))continue;
   let response;
   if(old)response=await client.from("trip_plans").update({data:t}).eq("id",t.id).eq("updated_at",old.updated_at).select("id,owner_id,data,shared_with,updated_at").maybeSingle();
   else response=await client.from("trip_plans").insert({id:t.id,data:t}).select("id,owner_id,data,shared_with,updated_at").single();
   if(epoch!==generation)return false;
   if(response.error||!response.data)throw response.error||Error("Turen er endret på en annen enhet, eller tilgang er fjernet.");
   const row=validRows([response.data])[0];baseline.set(t.id,row);
  }
  const present=new Set(target.map(t=>t.id));
  for(const [id,old] of [...baseline]){
   if(present.has(id))continue;
   if(old.owner_id!==user.id)throw Error("Bare eieren kan slette en delt tur.");
   const {data,error}=await client.from("trip_plans").delete().eq("id",id).eq("updated_at",old.updated_at).select("id").maybeSingle();
   if(epoch!==generation)return false;
   if(error||!data)throw error||Error("Turen er endret på en annen enhet. Sletting avbrutt.");
   baseline.delete(id);
  }
  dirty=false;clearDraft();status="Lagret i skyen · "+baseline.size+" turmapper";
  return true;
 }catch(e){
  if(epoch===generation)status="Ikke synkronisert: "+(e.message||"Lagringsfeil")+". Ulagrede endringer beholdes. Prøv igjen eller eksporter reservekopien.";
  return false;
 }finally{if(epoch===generation){busy=false;render();}}
}
async function setSession(session){
 const next=session?.user||null;
 if(next?.id===user?.id)return;
 generation++;busy=false;ready=false;dirty=false;baseline.clear();
 user=next;
 if(user){
  api.enterCloud();
  status="Henter dine private og delte turmapper …";render();
  if(!recovery)await load(true);
 }else{recovery=false;api.leaveCloud();status="Lokale turmapper. Logg inn for å synkronisere.";render();}
}
async function authAction(action){
 if(busy)return;
 const email=ui.email.value.trim(),password=ui.password.value;
 if(!recovery&&!email){show("Skriv inn e-postadressen.");return;}
 if(action!=="reset"&&password.length<8){show("Bruk minst åtte tegn i passordet.");return;}
 busy=true;show("Venter på Supabase …");
 try{
  let r;
  if(action==="login")r=await client.auth.signInWithPassword({email,password});
  if(action==="signup")r=await client.auth.signUp({email,password,options:{emailRedirectTo:redirect}});
  if(action==="reset")r=await client.auth.resetPasswordForEmail(email,{redirectTo:redirect});
  if(action==="recovery")r=await client.auth.updateUser({password});
  if(r.error)throw r.error;
  ui.password.value="";
  if(action==="signup"&&!r.data.session)show("Sjekk e-posten og bekreft kontoen. Logg inn etterpå.");
  else if(action==="reset")show("Hvis kontoen finnes, er det bedt om en e-post for å tilbakestille passordet.");
  else if(action==="recovery"){recovery=false;show("Passord oppdatert.");}
  else show("Innlogging bekreftet.");
 }catch(e){show(e.message||"Innlogging mislyktes.");}
 finally{busy=false;render();if(action==="recovery"&&user&&!recovery)load(true);}
}
async function transfer(){
 if(!user||!writable())return;
 const local=api.localTrips().filter(t=>!(t.id==="ny-tur"&&t.name==="Min første tur"&&!t.placeIds.length));
 if(!local.length){show("Ingen lokale turmapper å kopiere.");return;}
 const current=api.getTrips(),fresh=local.filter(t=>!current.some(c=>c.name===t.name&&c.lat===t.lat&&c.lng===t.lng&&c.radiusKm===t.radiusKm&&JSON.stringify(c.placeIds)===JSON.stringify(t.placeIds)));
 if(!fresh.length){show("De lokale turmappene finnes allerede i skyen.");return;}
 if(!confirm("Kopiere "+fresh.length+" lokale turmapper til din private skykonto? Lokale originaler og eksisterende skyturer beholdes."))return;
 const combined=[...current,...fresh.map(t=>({...t,id:crypto.randomUUID()}))];
 api.replace(combined);await save(combined);
}
async function share(){
 const id=api.selectedId(),old=baseline.get(id);
 if(!writable()||!isOwner(id)||!old)return;
 const value=prompt("Del turen med disse e-postadressene (kommaseparert). De må ha konto med samme e-postadresse. Tomt felt gjør turen privat igjen.",(old.shared_with||[]).join(", "));
 if(value===null)return;
 const emails=[...new Set(value.split(/[,;\n]/).map(x=>x.trim().toLowerCase()).filter(Boolean))];
 if(emails.length>20||emails.some(x=>!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x))){show("Ugyldig e-postliste, maks 20 adresser.");return;}
 if(!confirm(emails.length?"Gi disse kontoene lese- og redigeringstilgang til denne turen?":"Fjerne all deling av denne turen?"))return;
 const epoch=generation;busy=true;render();
 try{
  const {error}=await client.rpc("trip_share",{p_id:id,p_emails:emails,p_expected:old.updated_at});
  if(error)throw error;
  if(epoch!==generation)return;
  const rows=await fetchRows();if(epoch!==generation)return;applyRows(rows);
  show(emails.length?"Turmappe delt. Mottaker logger inn med samme e-postadresse.":"Turmappe er privat.");
 }catch(e){show("Deling mislyktes: "+e.message);}
 finally{if(epoch===generation){busy=false;render();}}
}
function downloadDraft(){
 const value=getDraft();if(!value)return;
 const href=URL.createObjectURL(new Blob([value],{type:"application/json"}));
 const a=document.createElement("a");a.href=href;a.download="usynkroniserte-turmapper.json";document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(href),5000);
}
function init(adapter){
 api=adapter;root=document.getElementById("trip-cloud");if(!root)return;
 for(const n of ["account","status","form","email","password","login","signup","reset","recovery","signout","refresh","transfer","share","retry","backup","discard"])ui[n]=byId("cloud-"+n);
 if(!window.supabase){show("Skybiblioteket ble ikke lastet. Lokale turmapper fungerer fortsatt.");return;}
 client=window.supabase.createClient(url,key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
 ui.form.addEventListener("submit",e=>{e.preventDefault();authAction(recovery?"recovery":"login");});
 ui.signup.onclick=()=>authAction("signup");ui.reset.onclick=()=>authAction("reset");ui.recovery.onclick=()=>authAction("recovery");
 ui.signout.onclick=async()=>{if(busy)return;if(dirty&&!confirm("Logge ut? Ulagrede endringer er bare lagret som lokal reservekopi hvis nettleseren tillot det. Eksporter først ved tvil."))return;busy=true;render();const {error}=await client.auth.signOut({scope:"local"});busy=false;if(error)show(error.message);else await setSession(null);};
 ui.refresh.onclick=()=>load(true);ui.transfer.onclick=transfer;ui.share.onclick=share;
 ui.retry.onclick=()=>{if(!busy&&dirty)save(api.getTrips());};ui.backup.onclick=downloadDraft;
 ui.discard.onclick=()=>{if(!busy&&dirty&&confirm("Forkast den ulagrede visningen og hent det som faktisk ligger i skyen? En eventuell lokal reservekopi beholdes.")){dirty=false;load(true);}};
 client.auth.onAuthStateChange((event,session)=>{if(event==="PASSWORD_RECOVERY")recovery=true;setTimeout(()=>{setSession(session).catch(e=>show(e.message));if(event==="PASSWORD_RECOVERY")render();},0);});
 render();
 setInterval(()=>{if(!document.hidden&&user&&ready&&!busy&&!dirty)load(false);},30000);
 window.addEventListener("focus",()=>{if(user&&ready&&!busy&&!dirty)load(false);});
 window.addEventListener("beforeunload",e=>{if(dirty||busy&&user){e.preventDefault();e.returnValue="";}});
}
window.ferieCloud={init,active,writable,save,isOwner,updateUI:render,canDelete:id=>!user||isOwner(id)};
})();