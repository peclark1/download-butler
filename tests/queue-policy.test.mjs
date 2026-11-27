import test from 'node:test';
import assert from 'node:assert/strict';
import {concurrency,availableSlots} from '../extension/queue-policy.js';
test('default and arbitrary limits',()=>{assert.equal(concurrency(),3);assert.equal(concurrency(57),57);assert.equal(concurrency(0),0);for(const v of [-1,1.5,NaN,Infinity,'3'])assert.throws(()=>concurrency(v));});
test('slots respect active transfers',()=>{assert.equal(availableSlots(3,2,9),1);assert.equal(availableSlots(3,3,9),0);assert.equal(availableSlots(0,5,9),9);assert.equal(availableSlots(99,0,4),4);});
