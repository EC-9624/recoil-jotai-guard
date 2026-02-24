// This file has function calls that look like atom/selector but aren't from recoil
function atom(x: any) {
  return x;
}

const result = atom({key: 'fake', default: ''});
