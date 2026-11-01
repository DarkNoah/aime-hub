
import React from 'react';import {createRoot} from 'react-dom/client';import {initializeI18n} from '@/i18n';import './styles.css';
import {ProviderActionDialog} from '@/pages/admin/providers/components/provider-action-dialog';import {providerApi} from '@/pages/admin/providers/api';
const params=new URLSearchParams(location.search);
const provider={id:'mock-provider',name:'通用配置测试',type:'xinference',baseUrl:'https://inference.example/v1',enabled:true,hasApiKey:true,metadata:{tenantId:'before',notes:'old notes',mode:'fast',streaming:true,legacy:'keep-me'},modelCount:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
if(params.has('alibaba'))Object.assign(provider,{type:'alibaba-cn',metadata:{workspaceId:'workspace-before',region:'cn-beijing',legacy:'keep-me'}});
providerApi.update=async(id,body)=>{window.savedBody=body;return {...provider,...body};};
window.failDefinitions=params.has('fail');
const load=providerApi.configurations;
providerApi.configurations=async(signal)=>{if(window.failDefinitions)throw new TypeError('Mock definition load failure');return load(signal);};
void initializeI18n().then(()=>createRoot(document.getElementById('root')).render(<ProviderActionDialog action={{kind:'provider',provider}} onClose={()=>{}} onSuccess={()=>{window.saved=true;}} restoreFocus={()=>{}}/>));
