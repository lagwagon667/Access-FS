const daoHiddenObject = 0x00000001;
const daoSystemObject = 0x80000000;
const msysHiddenObject = 0x00000001;
const msysSystemObject = 0x00000002;

export function isAccessSystemTable(name: string): boolean {
    return /^MSys/i.test(name);
}

export function isDaoHiddenOrSystem(attributes: number): boolean {
    return (attributes & daoHiddenObject) !== 0 || (attributes & daoSystemObject) !== 0;
}

export function isMsysHiddenOrSystem(flags: number): boolean {
    return (flags & (msysHiddenObject | msysSystemObject)) !== 0;
}
