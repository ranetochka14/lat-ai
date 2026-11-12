import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Tutor} from '../core/src/tutor.mjs';
import {createLifecycle} from '../lifecycle.mjs';

test('local budgets are opt-in, bounded integers and do not change defaults',()=>{
 const defaults=new Tutor();
 assert.equal(defaults.budget,8000);assert.equal(defaults.studyBudget,180000);
 const local=new Tutor({modelBudgetMs:60000,studyBudgetMs:900000});
 assert.equal(local.budget,60000);assert.equal(local.studyBudget,900000);
 for(const value of [60001,Infinity,NaN,'60000',true,7900.5])assert.throws(()=>new Tutor({modelBudgetMs:value}));
 for(const value of [179999,900001,Infinity,'900000',true])assert.throws(()=>new Tutor({studyBudgetMs:value}));
 assert.equal(createLifecycle({modelBudgetMs:60000,studyBudgetMs:900000}).health().tutor.enabled,false);
});
